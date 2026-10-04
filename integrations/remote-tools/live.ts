import { createRemoteTools, type Clients } from './index.js';
type Scope = Omit<Clients, 'kernel' | 'sprites' | 'executor' | 'neon' | 'liveReady'>;
/** Server-only factory. Each credential independently enables its sponsor; no network at construction. */
export async function createLiveRemoteTools(env: Record<string, string | undefined>, scope: Scope) {
  const clients: Clients = { ...scope, liveReady: true };
  if (env.KERNEL_API_KEY) {
    const { default: Kernel } = await import('@onkernel/sdk');
    const kernel = new Kernel({ apiKey: env.KERNEL_API_KEY, maxRetries: 0, timeout: 30_000 });
    clients.kernel = { browsers: {
      create: (body, options) => kernel.browsers.create(body, options),
      deleteByID: (id, options) => kernel.browsers.deleteByID(id, options),
      playwright: { async execute(id, body, options) {
        const response = await kernel.browsers.playwright.execute(id, { ...body, timeout_sec: 20 }, options);
        if (!response.success) throw new Error('Kernel page research failed');
        return { result: response.result };
      } }
    } };
  }
  if (env.SPRITES_TOKEN) {
    const { SpritesClient } = await import('@fly/sprites');
    const sprites = new SpritesClient(env.SPRITES_TOKEN);
    clients.sprites = { sprite: name => ({ async execFile(file, args, options) {
      const result = await sprites.sprite(name).execFile(file, args, { ...options, encoding: 'utf8', maxBuffer: 128_000, timeout: 25_000, maxRunAfterDisconnect: '0s' });
      return { stdout: result.stdout.toString(), exitCode: result.exitCode };
    } }) };
  }
  if (env.NEON_DATABASE_URL) {
    const { neon } = await import('@neondatabase/serverless');
    const sql = neon(env.NEON_DATABASE_URL);
    clients.neon = { query: (text, values, { signal }) => sql.query(text, values, { fetchOptions: { signal } }) };
  }
  if (env.EXECUTOR_API_KEY && env.EXECUTOR_MCP_URL) {
    const endpoint = new URL(env.EXECUTOR_MCP_URL);
    if (endpoint.origin !== 'https://v2.executor.sh' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error('Invalid hosted Executor MCP endpoint');
    const expected = `/org/${encodeURIComponent(scope.executorOrganization)}/mcp`;
    if (endpoint.pathname !== expected && endpoint.pathname !== '/mcp') throw new Error('Executor endpoint does not match approved organization');
    const [{ Client }, { StreamableHTTPClientTransport }] = await Promise.all([import('@modelcontextprotocol/sdk/client/index.js'), import('@modelcontextprotocol/sdk/client/streamableHttp.js')]);
    clients.executor = { async callTool(input, { signal }) {
      const client = new Client({ name: 'neon-superpowers', version: '0.1.0' });
      const transport = new StreamableHTTPClientTransport(endpoint, { requestInit: { headers: { Authorization: `Bearer ${env.EXECUTOR_API_KEY}`, 'X-Executor-Organization': scope.executorOrganization }, signal } });
      try {
        await client.connect(transport);
        const result = await client.callTool(input, undefined, { signal, timeout: 25_000 });
        if (result.isError) throw new Error('Executor public research tool failed');
        // Approval requests remain visible to caller; never automatically resumed.
        return result;
      } finally { await client.close(); }
    } };
  }
  return createRemoteTools(clients);
}
