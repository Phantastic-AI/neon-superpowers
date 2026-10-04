/** Server-only sponsor capabilities. SDK clients and authority are injected. */
export type Sponsor = 'Kernel' | 'Sprites' | 'Executor' | 'Neon';
export interface Receipt<T> { sponsor: Sponsor; action: string; resource: string; output: T; cost: { usd: null; status: 'unknown' }; }
export interface Approval { sponsor: Sponsor; action: string; resource: string; payload: unknown; }
export interface EventSnapshot { id: string; title: string; startsAt: string; location: string; sourceUrl: string; }
type Options = { signal?: AbortSignal };
export interface Clients {
  kernel?: { browsers: { create(body: { headless: boolean }, options: Options): Promise<{ session_id: string }>; playwright: { execute(id: string, body: { code: string }, options: Options): Promise<{ result: unknown }> }; deleteByID(id: string, options: Options): Promise<unknown> } };
  sprites?: { sprite(name: string): { execFile(file: string, args: string[], options?: Options): Promise<{ stdout: string; exitCode?: number }> } };
  executor?: { callTool(input: { name: string; arguments: Record<string, unknown> }, options: Options): Promise<unknown> };
  neon?: { query(sql: string, values: unknown[], options: Options): Promise<unknown> };
  approve(request: Approval): Promise<boolean>;
  liveReady: boolean;
  /** Dedicated demo sprite and Neon database identifiers; never inferred from credentials. */
  spriteName: string;
  databaseScope: string;
  executorOrganization: string;
  allowedResearchHosts: string[];
  /** Exact read-only public tool paths reviewed after Executor discovery. Never mail/calendar. */
  executorResearchTools?: string[];
}
const receipt = <T>(sponsor: Sponsor, action: string, resource: string, output: T): Receipt<T> => ({ sponsor, action, resource, output, cost: { usd: null, status: 'unknown' } });
function freezeJson<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freezeJson(child);
    Object.freeze(value);
  }
  return value;
}
function limited(value: string, max: number, label: string) { if (!value || value.length > max) throw new Error(`Invalid ${label}`); return value; }
export function createRemoteTools(clients: Clients) {
  async function run<T>(request: Approval, work: (signal: AbortSignal) => Promise<T>, external?: AbortSignal): Promise<Receipt<T>> {
    if (!clients.liveReady || !clients[request.sponsor.toLowerCase() as 'kernel' | 'sprites' | 'executor' | 'neon']) throw new Error('Remote capabilities are disabled until credentials and scope are ready');
    if (external?.aborted) throw new Error('Cancelled');
    if (!await clients.approve(request)) throw new Error('Remote action declined');
    if (external?.aborted) throw new Error('Cancelled');
    const controller = new AbortController();
    const cancel = () => controller.abort(external?.reason);
    external?.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(() => controller.abort(new Error('Remote timeout')), 30_000);
    try {
      const aborted = new Promise<never>((_, reject) => controller.signal.addEventListener('abort', () => reject(new Error('Remote action cancelled or timed out')), { once: true }));
      return receipt(request.sponsor, request.action, request.resource, await Promise.race([work(controller.signal), aborted]));
    } finally { clearTimeout(timer); external?.removeEventListener('abort', cancel); }
  }
  return {
    researchPage(rawUrl: string, signal?: AbortSignal) {
      const url = new URL(limited(rawUrl, 2048, 'URL'));
      if (url.protocol !== 'https:' || url.username || url.password || !clients.allowedResearchHosts.includes(url.hostname)) throw new Error('Research host is outside the approved public scope');
      return run({ sponsor: 'Kernel', action: 'Read public event page in disposable browser', resource: url.href, payload: { url: url.href } }, async signal => {
        const browser = await clients.kernel!.browsers.create({ headless: true }, { signal });
        try {
          const response = await clients.kernel!.browsers.playwright.execute(browser.session_id, { code: `await page.route('**/*', route => { const u = new URL(route.request().url()); return u.protocol === 'https:' && u.hostname === ${JSON.stringify(url.hostname)} ? route.continue() : route.abort(); }); await page.goto(${JSON.stringify(url.href)}, {timeout: 15000}); return {url: page.url(), title: await page.title(), text: (await page.locator('body').innerText()).slice(0, 12000)};` }, { signal });
          return response.result;
        } finally { await clients.kernel!.browsers.deleteByID(browser.session_id, { signal: AbortSignal.timeout(5000) }); }
      }, signal);
    },
    normalizeCsv(csv: string, signal?: AbortSignal) {
      limited(csv, 64_000, 'CSV');
      if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(clients.spriteName)) throw new Error('Invalid dedicated sprite name');
      // JSON is embedded into Python as a JSON string literal, never interpolated into shell code.
      const program = `import csv,io,json\ndata=json.loads(${JSON.stringify(JSON.stringify(csv))})\nrows=list(csv.DictReader(io.StringIO(data)))\nassert len(rows)<=500\nout=[];seen=set()\nfor row in rows:\n r={k.strip().lower(): (v or '').strip() for k,v in row.items() if k is not None}\n key=tuple(sorted((k,v.casefold()) for k,v in r.items()))\n if key not in seen: seen.add(key);out.append(r)\nprint(json.dumps({'rows':out,'inputRows':len(rows),'duplicatesRemoved':len(rows)-len(out)}))`;
      return run({ sponsor: 'Sprites', action: 'Normalize and deduplicate selected guest CSV', resource: clients.spriteName, payload: { csv, maximumRows: 500 } }, async signal => {
        const response = await clients.sprites!.sprite(clients.spriteName).execFile('python3', ['-c', program], { signal });
        if (response.exitCode !== undefined && response.exitCode !== 0) throw new Error('Guest CSV computation failed');
        if (response.stdout.length > 128_000) throw new Error('Guest CSV result exceeds limit');
        return JSON.parse(response.stdout) as { rows: Record<string, string>[]; inputRows: number; duplicatesRemoved: number };
      }, signal);
    },
    discoverResearchTools(query: string, signal?: AbortSignal) {
      limited(query, 200, 'research query');
      limited(clients.executorOrganization, 100, 'Executor organization');
      return run({ sponsor: 'Executor', action: 'Discover configured public research tools', resource: clients.executorOrganization, payload: { query } }, signal => clients.executor!.callTool({ name: 'execute', arguments: { code: `return await tools.search({query:${JSON.stringify(query)}});` } }, { signal }), signal);
    },
    executeResearchTool(path: string, args: Record<string, unknown>, signal?: AbortSignal) {
      if (!/^tools\.[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*$/.test(path) || !clients.executorResearchTools?.includes(path)) throw new Error('Executor tool is outside the reviewed public research allowlist');
      const serialized = JSON.stringify(args);
      const approvedArgs: Record<string, unknown> = freezeJson(JSON.parse(serialized));
      if (serialized.length > 8000) throw new Error('Research tool arguments exceed limit');
      return run({ sponsor: 'Executor', action: 'Run selected public research tool', resource: `${clients.executorOrganization}:${path}`, payload: freezeJson({ path, args: approvedArgs }) }, signal => clients.executor!.callTool({ name: 'execute', arguments: { code: `return await ${path}(${serialized});` } }, { signal }), signal);
    },
    prepareSnapshotSharing(signal?: AbortSignal) {
      const sql = "CREATE TABLE IF NOT EXISTS neon_event_snapshots (id uuid PRIMARY KEY, events jsonb NOT NULL CHECK (jsonb_typeof(events) = 'array'), created_at timestamptz NOT NULL DEFAULT now())";
      return run({ sponsor: 'Neon', action: 'Prepare selected event snapshot table', resource: clients.databaseScope, payload: { table: 'neon_event_snapshots', sql } }, async signal => {
        await clients.neon!.query(sql, [], { signal });
        return { table: 'neon_event_snapshots', ready: true };
      }, signal);
    },
    shareEventSnapshot(selected: EventSnapshot[], signal?: AbortSignal) {
      if (!selected.length || selected.length > 20) throw new Error('Select between 1 and 20 events');
      const events = selected.map(event => ({ id: limited(event.id, 100, 'id'), title: limited(event.title, 300, 'title'), startsAt: limited(event.startsAt, 100, 'start'), location: limited(event.location, 300, 'location'), sourceUrl: limited(event.sourceUrl, 2048, 'source URL') }));
      const snapshotId = crypto.randomUUID();
      return run({ sponsor: 'Neon', action: 'Share explicitly selected event snapshot', resource: clients.databaseScope, payload: { snapshotId, events } }, async signal => {
        await clients.neon!.query('INSERT INTO neon_event_snapshots (id, events) VALUES ($1, $2::jsonb)', [snapshotId, JSON.stringify(events)], { signal });
        return { snapshotId, eventCount: events.length };
      }, signal);
    }
  };
}
