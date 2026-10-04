import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { z } from 'zod';
import type { CapabilityTool, NeonAgentConfig } from '../../integrations/agent/index.ts';
import type { ConnectorCapabilities, PreparedInbox } from '../../integrations/connectors/index.ts';
import type { World } from '../../tools/projections/types.js';
import { loadVaultWorld, resolveVaultDir } from '../vault.js';
import { handlePeopleApi } from '../people-api.js';
import { ApprovalLedger } from './ledger.ts';
import { LaunchState } from './state.ts';
import { controlledRecipient, createNeonCapabilities, enrichmentRunner, localPeople, NEON_INSTRUCTIONS, validateInvitation } from './capabilities.ts';

const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const BODY_LIMIT=128*1024;
interface Runtime {handleRun(request:Request):Promise<Response>;pending(threadId:string):Promise<unknown[]>;cancel(threadId:string):boolean;snapshot?(threadId:string):Promise<unknown>}
interface RuntimeOptions {config:NeonAgentConfig;tools:CapabilityTool[];instructions:string;resourceId:string;dataDirectory:string}
export interface NeonServiceOptions {
 directory:string; env?:Record<string,string|undefined>; world?:World|(()=>World); vaultDirectory?:string;
 /** Test injection; production readiness is an explicit local marker, never key presence. */
 ready?:()=>boolean;
 connectorsFactory?:(options:{userId:string;approval:ApprovalLedger;env:Record<string,string|undefined>})=>Promise<ConnectorCapabilities>;
 runtimeFactory?:(options:RuntimeOptions)=>Promise<Runtime>;
}
class Failure extends Error {constructor(readonly status:number,readonly code:string,readonly publicMessage:string){super(publicMessage);}}
function reject(status:number,code:string,message:string):never{throw new Failure(status,code,message);}
function json(res:ServerResponse,status:number,value:unknown){res.statusCode=status;res.setHeader('Content-Type','application/json');res.setHeader('Cache-Control','no-store');res.end(JSON.stringify(value));}
async function body(req:IncomingMessage):Promise<unknown>{
 if(req.headers['content-type']?.split(';')[0].trim()!=='application/json')reject(415,'json_required','Use application/json.');
 const declared=Number(req.headers['content-length']);if(Number.isFinite(declared)&&declared>BODY_LIMIT)reject(413,'body_too_large','Request is too large.');
 const chunks:Buffer[]=[];let size=0;
 for await(const piece of req){const bytes=Buffer.from(piece);size+=bytes.length;if(size>BODY_LIMIT)reject(413,'body_too_large','Request is too large.');chunks.push(bytes);}
 try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{return reject(400,'invalid_json','Use valid JSON.');}
}
function modelConfig(env:Record<string,string|undefined>):NeonAgentConfig|null {
 const apiKey=env.NEON_AI_GATEWAY_TOKEN??env.NEON_AI_GATEWAY_API_KEY,model=env.NEON_MODEL;
 try{const url=new URL(env.NEON_AI_GATEWAY_BASE_URL??'');if(!apiKey||!model||url.protocol!=='https:'||url.username||url.password||url.search||url.hash||url.pathname!=='/')return null;return {apiKey,baseURL:url.origin,model};}catch{return null;}
}
export function createNeonService(options:NeonServiceOptions) {
 const directory=resolve(options.directory),env=options.env??process.env;
 const ready=options.ready??(()=>existsSync(join(directory,'keys-ready')));
 const ledger=new ApprovalLedger(directory),state=new LaunchState(directory);
 const world=()=>typeof options.world==='function'?options.world():options.world??loadVaultWorld();
 const userId=env.COMPOSIO_USER_ID||'neon-local',resourceId=userId;
 const dataDirectory=join(directory,'agent');
 let connectorPromise:Promise<ConnectorCapabilities>|undefined,runtimePromise:Promise<Runtime>|undefined;
 const checkReady=()=>{if(!ready())reject(503,'keys_not_ready','Save your local configuration and confirm keys ready before using providers.');};
 const connectorEnvironment=()=>{
  if(env.AGENTMAIL_INBOX_ID||!env.AGENTMAIL_API_KEY)return env;
  const accountId='agentmail-key:'+createHash('sha256').update(env.AGENTMAIL_API_KEY).digest('hex');
  const book=ledger.inspect();
  const completed=Object.values(book.operations).filter(op=>op.state==='complete').sort((a,b)=>(a.completedAt??'').localeCompare(b.completedAt??''));
  let inboxId:string|undefined;
  for(const op of completed){const approval=book.approvals[op.approvalId],draft=approval&&book.drafts[approval.draftId];const payload=draft?.payload as PreparedInbox|undefined;const receipt=op.receipt as {accountId?:string;inboxId?:string}|undefined;if(payload?.operation==='create_inbox'&&payload.userId===userId&&receipt?.accountId===accountId&&receipt.inboxId)inboxId=receipt.inboxId;}
  return inboxId?{...env,AGENTMAIL_INBOX_ID:inboxId}:env;
 };
 const connectors=async()=>{
  checkReady();
  connectorPromise??=(async()=>{const factory=options.connectorsFactory??(await import('../../integrations/connectors/sdk.ts')).createSdkConnectors;return factory({userId,approval:ledger,env:connectorEnvironment()});})();
  try{return await connectorPromise;}catch{connectorPromise=undefined;return reject(503,'connectors_unavailable','The configured connector could not be initialized.');}
 };
 const runtime=async()=>{
  checkReady();const config=modelConfig(env);if(!config)reject(503,'provider_not_configured','Configure the model gateway before starting a conversation.');
  runtimePromise??=(async()=>{
   const factory=options.runtimeFactory??(await import('../../integrations/agent/index.ts')).createLocalNeonAgentRuntime;
   return factory({config:config!,tools:createNeonCapabilities({world,ledger,state,directory,env,connectors,ready,vaultDirectory:options.vaultDirectory??(options.world?undefined:resolveVaultDir()),enrich:enrichmentRunner(ROOT,env,directory)}),instructions:NEON_INSTRUCTIONS,resourceId,dataDirectory});
  })();
  try{return await runtimePromise;}catch{runtimePromise=undefined;return reject(503,'runtime_unavailable','The local agent could not be initialized.');}
 };
 const threadSnapshot=async(threadId:string|null)=>{
  const empty={messages:[],pending:[],state:{},status:'idle',runIds:[]};
  if(!threadId)return empty;
  if(!/^[A-Za-z0-9_-]{1,128}$/.test(threadId))reject(400,'invalid_thread','Use a valid thread ID.');
  if(runtimePromise){const agent=await runtimePromise;if(agent.snapshot)return agent.snapshot(threadId);return {...empty,pending:await agent.pending(threadId)};}
  // Status never initializes a SDK, connects an account, or calls a provider.
  const key=createHash('sha256').update(JSON.stringify({resourceId,threadId})).digest('hex');
  const file=join(dataDirectory,'threads',key+'.json');
  if(!existsSync(file))return empty;
  const saved=JSON.parse(readFileSync(file,'utf8'));return {...empty,...saved,messages:saved.messages??[]};
 };
 const server=createServer((req,res)=>{void route(req,res).catch(error=>{
  if(res.headersSent){res.destroy();return;}
  if(error instanceof Failure)json(res,error.status,{error:error.publicMessage,code:error.code});
  else if(error instanceof z.ZodError)json(res,400,{error:'The request has invalid or unsupported fields.',code:'invalid_input'});
  else json(res,409,{error:'The action could not be completed. Refresh its state before continuing.',code:'action_unavailable'});
 });});
 function authenticate(req:IncomingMessage,res:ServerResponse){
  const address=server.address();const port=typeof address==='object'&&address?address.port:5275;
  const hosts=new Set([`localhost:${port}`,`127.0.0.1:${port}`,'localhost:5275','127.0.0.1:5275','localhost:5299','127.0.0.1:5299']);
  if(!req.headers.host||!hosts.has(req.headers.host))reject(403,'local_host_required','Open this service through the local app.');
  const origins=new Set(['http://localhost:5299','http://127.0.0.1:5299','http://localhost:5275','http://127.0.0.1:5275']);
  const origin=req.headers.origin;
  if(origin&&!origins.has(origin))reject(403,'local_origin_required','Use the local app origin.');
  if(['POST','DELETE','OPTIONS'].includes(req.method??'')&&!origin)reject(403,'local_origin_required','Use the local app origin.');
  if(origin){res.setHeader('Access-Control-Allow-Origin',origin);res.setHeader('Vary','Origin');}
  res.setHeader('X-Content-Type-Options','nosniff');
 }
 async function route(req:IncomingMessage,res:ServerResponse){
  authenticate(req,res);
  if(!req.url?.startsWith('/')||req.url.startsWith('//'))reject(400,'invalid_path','Use a local API path.');
  const url=new URL(req.url!,'http://localhost:5275');
  if(req.method==='OPTIONS'){res.setHeader('Access-Control-Allow-Methods','GET, POST, DELETE');res.setHeader('Access-Control-Allow-Headers','Content-Type');res.statusCode=204;res.end();return;}
  if(req.method==='GET'&&url.pathname==='/api/neon/status'){
   const snapshot=state.read(),book=ledger.inspect();
   const configured={provider:ready()&&!!modelConfig(env),composio:ready()&&!!env.COMPOSIO_API_KEY,agentmail:ready()&&!!env.AGENTMAIL_API_KEY,exa:ready()&&!!env.EXA_API_KEY,kernel:ready()&&!!env.KERNEL_API_KEY,sprites:ready()&&!!env.SPRITES_TOKEN,executor:ready()&&!!env.EXECUTOR_API_KEY&&!!env.EXECUTOR_MCP_URL,neon:ready()&&!!env.NEON_DATABASE_URL};
   const pending=Object.values(book.drafts).filter(d=>!d.revokedAt&&(!d.approvalId||!book.approvals[d.approvalId]?.operationKey));
   const operations=Object.values(book.operations).map(op=>({sponsor:'mail',action:'dispatch',status:op.state,startedAt:op.startedAt,completedAt:op.completedAt,receipt:op.receipt??null}));
   json(res,200,{configured,keysReady:ready(),demoRecipient:controlledRecipient(env),agentInboxId:connectorEnvironment().AGENTMAIL_INBOX_ID||null,pending,nativeInterrupts:((await threadSnapshot(url.searchParams.get('threadId'))) as {pending:unknown[]}).pending,receipts:[...snapshot.receipts,...operations],goal:snapshot.goal,shortlist:snapshot.shortlist,selectedPersonIds:snapshot.selectedPersonIds,notes:snapshot.notes});return;
  }
  if(req.method==='GET'&&url.pathname==='/api/neon/agent/thread'){json(res,200,await threadSnapshot(url.searchParams.get('threadId')));return;}
  if(req.method==='GET'&&url.pathname==='/api/neon/people'){json(res,200,{people:localPeople(world()),source:'local_vault'});return;}
  // The inherited post-it workspace owns its vault mutation semantics. The
  // alias supplies the same actual local vault, rather than a parallel store.
  const peoplePath='/api/neon/people-workspace';
  if(url.pathname===peoplePath||['/order','/note','/waves'].some(s=>url.pathname===peoplePath+s)){
   if(req.method==='POST'){
    const input=await body(req);
    // handlePeopleApi consumes its own stream, so replay only validated bounded JSON.
    const {Readable}=await import('node:stream');
    const proxy=Object.assign(Readable.from([Buffer.from(JSON.stringify(input))]),{method:req.method,url:'/api/lois/people'+url.pathname.slice(peoplePath.length)+url.search,headers:{...req.headers,host:new URL(req.headers.origin!).host}}) as unknown as IncomingMessage;
    handlePeopleApi(proxy,res,{world:world(),vaultDir:options.vaultDirectory??resolveVaultDir()});
   }else{
    const alias=Object.create(req) as IncomingMessage;alias.url='/api/lois/people'+url.pathname.slice(peoplePath.length)+url.search;
    handlePeopleApi(alias,res,{world:world(),vaultDir:options.vaultDirectory??resolveVaultDir()});
   }
   return;
  }
  if(req.method==='POST'&&url.pathname==='/api/neon/agent'){
   if(url.search)reject(400,'invalid_path','Put run input in the JSON body.');
   const input=await body(req),agent=await runtime();
   const abort=new AbortController();req.once('aborted',()=>abort.abort());res.once('close',()=>{if(!res.writableEnded)abort.abort();});
   const response=await agent.handleRun(new Request('http://localhost:5275/api/neon/agent',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input),signal:abort.signal}));
   res.statusCode=response.status;for(const name of ['content-type','cache-control','x-accel-buffering']){const value=response.headers.get(name);if(value)res.setHeader(name,value);}
   if(!response.body){res.end();return;}
   const reader=response.body.getReader();
   try{while(!abort.signal.aborted){const part=await reader.read();if(part.done)break;if(!res.write(Buffer.from(part.value)))await once(res,'drain',{signal:abort.signal});}res.end();}finally{await reader.cancel();}
   return;
  }
  const match=/^\/api\/neon\/(approvals|drafts|connections)\/([A-Za-z0-9_-]{1,128})$/.exec(url.pathname);
  if(!match)reject(404,'not_found','Route not found.');
  const kind=match![1],id=match![2]!;
  if(url.search)reject(400,'invalid_path','Put action input in the JSON body.');
  if(kind==='connections'&&req.method==='POST'){
   z.object({}).strict().parse(await body(req));
   const toolkit=z.enum(['gmail','googlecalendar']).parse(id);
   json(res,200,await (await connectors()).initiateConnection({toolkit,callbackUrl:'http://localhost:5299/neon'}));return;
  }
  const drafts=ledger.inspect().drafts;const draft=Object.hasOwn(drafts,id)?drafts[id]:undefined;if(!draft)reject(404,'draft_not_found','Draft not found.');
  if(kind==='drafts'&&req.method==='DELETE'){ledger.revoke(id);json(res,200,{revoked:true});return;}
  if(req.method!=='POST')reject(405,'method_not_allowed','Use the supported action method.');
  const input=await body(req);
  if(kind==='drafts'){
   const edit=z.object({to:z.array(z.string().email()).length(1),subject:z.string().min(1).max(998),body:z.string().min(1).max(100000)}).strict().parse(input);
   const current=validateInvitation(draft.payload,controlledRecipient(env));
   json(res,200,ledger.replace(id,validateInvitation({...current,...edit},controlledRecipient(env))));return;
  }
  if(kind==='approvals'){
   const {hash}=z.object({hash:z.string().regex(/^[a-f0-9]{64}$/)}).strict().parse(input);
   const payload=draft.payload as {operation?:string};
   // Resolve a configured connector before issuing an authorization. Its
   // sendPrepared/createAgentInbox calls consume this exact ledger approval.
   const connector=await connectors();
   if(payload.operation==='send_email')validateInvitation(payload,controlledRecipient(env));
   else if(payload.operation!=='create_inbox')reject(400,'invalid_draft','Unsupported draft operation.');
   const approval=ledger.approve(id,hash),auth={approvalId:approval.id,idempotencyKey:`neon-draft:${id}`};
   const receipt=payload.operation==='send_email'?await connector.sendPrepared(validateInvitation(payload,controlledRecipient(env)),auth):await connector.createAgentInbox(payload as PreparedInbox,auth);
   if(payload.operation==='create_inbox')connectorPromise=undefined;
   json(res,200,{receipt});return;
  }
  reject(405,'method_not_allowed','Use the supported action method.');
 }
 return Object.assign(server,{neon:{ledger,state,capabilities:()=>createNeonCapabilities({world,ledger,state,directory,env,connectors,ready,vaultDirectory:options.vaultDirectory??(options.world?undefined:resolveVaultDir()),enrich:enrichmentRunner(ROOT,env,directory)})}});
}
export const createNeonServer=createNeonService;
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const server=createNeonService({directory:resolve(ROOT,'.local'),...(process.env.NEON_VAULT_DIRECTORY?{vaultDirectory:resolve(process.env.NEON_VAULT_DIRECTORY),world:()=>loadVaultWorld(resolve(process.env.NEON_VAULT_DIRECTORY!))}:{})});
 server.listen(5275,'127.0.0.1',()=>console.log('Neon sidecar listening at http://localhost:5275'));
 for(const signal of ['SIGINT','SIGTERM'] as const)process.once(signal,()=>server.close());
}
