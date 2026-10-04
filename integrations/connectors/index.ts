/** Server-only connector capabilities. The parent ledger owns authorization and retries. */
export type Toolkit = 'gmail' | 'googlecalendar';
export type MailProvider = 'gmail' | 'agentmail';
export interface PreparedSend {
  readonly operation: 'send_email'; readonly provider: MailProvider;
  readonly userId: string; readonly accountId: string;
  readonly to: readonly string[]; readonly subject: string; readonly body: string;
}
export interface PreparedInbox { readonly operation: 'create_inbox'; readonly provider: 'agentmail'; readonly userId: string; readonly accountId: string; readonly displayName: string; readonly clientId: string }
export interface InboxReceipt { provider: 'agentmail'; accountId: string; inboxId: string }
export type ApprovalEnvelope = PreparedSend | PreparedInbox;
export type ProviderReceipt = SendReceipt | InboxReceipt;
export interface SendReceipt { provider: MailProvider; accountId: string; messageId: string; threadId?: string }
export interface SendAuthorization { approvalId: string; idempotencyKey: string }
/** Atomically verify this exact envelope, reserve authorization, dispatch once, persist receipt.
 * Replay returns stored receipt; in-flight/uncertain attempts must never be redispatched.
 * The callback can fail after provider acceptance: keep that attempt blocked for reconciliation.
 */
export interface ApprovedExecutor {
  run<T extends ProviderReceipt>(envelope: ApprovalEnvelope, authorization: SendAuthorization, dispatch: () => Promise<T>): Promise<T>;
}
export interface AccountQuery { userIds: string[]; toolkitSlugs: string[]; authConfigIds?: string[]; accountType: 'PRIVATE'; limit: number; cursor?: string }
export interface ProxyRequest {
  endpoint: string; method: 'GET' | 'POST'; connectedAccountId: string;
  parameters?: Array<{ in: 'query' | 'header'; name: string; value: string | number }>;
  body?: unknown;
}
export interface ComposioPort {
  listAccounts(query: AccountQuery): Promise<unknown>;
  authorize(userId: string, toolkit: Toolkit, options: {callbackUrl: string; authConfigId?: string}): Promise<unknown>;
  proxy(request: ProxyRequest): Promise<unknown>;
}
export interface AgentMailPort {
  getInbox(inboxId: string): Promise<unknown>;
  listMessages(inboxId: string, options: {limit: number}): Promise<unknown>;
  getMessage(inboxId: string, messageId: string): Promise<unknown>;
  sendMessage(inboxId: string, payload: {to: string[]; subject: string; text: string}): Promise<unknown>;
  createInbox(request: {displayName: string; clientId: string}): Promise<unknown>;
}
export interface ConnectorOptions {
  userId: string; composio?: ComposioPort; agentmail?: AgentMailPort; approval?: ApprovedExecutor;
  gmailAuthConfigId?: string; calendarAuthConfigId?: string;
  gmailConnectedAccountId?: string; calendarConnectedAccountId?: string; agentMailInboxId?: string;
  /** Credential fingerprint supplied by the server factory; never a raw key. */
  agentMailProvisioningAccountId?: string;
}
export type ConnectorErrorCode = 'not_configured' | 'not_connected' | 'ambiguous_account' | 'invalid_input' | 'scope_mismatch' | 'approval_required' | 'unauthorized' | 'rate_limited' | 'provider_error' | 'invalid_response';
export class ConnectorError extends Error {
  readonly code: ConnectorErrorCode; readonly status?: number;
  constructor(code: ConnectorErrorCode, status?: number) { super(`Connector ${code}`); this.name='ConnectorError'; this.code=code; this.status=status; }
}
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string,unknown> : {};
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const text = (value: unknown, max=16000): string => typeof value === 'string' ? value.slice(0,max) : '';
function required(value: unknown, max=256): string {
 if (typeof value !== 'string' || !value.trim() || value.length>max || /[\x00-\x1f\x7f]/.test(value)) throw new ConnectorError('invalid_input'); return value;
}
function limit(value=20): number { if(!Number.isInteger(value) || value<1 || value>100) throw new ConnectorError('invalid_input'); return value; }
function providerError(error: unknown): ConnectorError {
 if(error instanceof ConnectorError) return error;
 const e=record(error); const status=typeof e.statusCode==='number' ? e.statusCode : typeof e.status==='number' ? e.status : undefined;
 return new ConnectorError(status===429 ? 'rate_limited' : status===401 || status===403 ? 'unauthorized' : 'provider_error',status);
}
async function safe<T>(call:()=>Promise<T>):Promise<T> { try{return await call();}catch(error){throw providerError(error);} }
function response(value: unknown): Record<string,unknown> {
 const r=record(value); if(typeof r.status!=='number') throw new ConnectorError('invalid_response');
 if(r.status<200 || r.status>=300) throw providerError({status:r.status});
 return record(r.data);
}
export interface MailMessage { id: string; threadId?: string; from: string; to: string[]; subject: string; body: string; snippet?: string; timestamp?: string }
function gmailMessage(value: unknown): MailMessage {
 const r=record(value), payload=record(r.payload), headers=list(payload.headers).map(record);
 const header=(name:string)=>text(headers.find(h=>text(h.name).toLowerCase()===name)?.value,2000);
 const plain=(part:Record<string,unknown>):string => {
   if(text(part.mimeType)==='text/plain' || !part.mimeType) { const data=text(record(part.body).data,90000); if(data) return Buffer.from(data,'base64url').toString('utf8').slice(0,16000); }
   for(const child of list(part.parts)) { const body=plain(record(child)); if(body) return body; } return '';
 };
 return {id:required(r.id),threadId:text(r.threadId)||undefined,from:header('from'),to:header('to').split(',').map(v=>v.trim()).filter(Boolean),subject:header('subject'),body:plain(payload),snippet:text(r.snippet),timestamp:text(r.internalDate)||undefined};
}
function agentMessage(value:unknown):MailMessage {
 const r=record(value); return {id:required(r.messageId),threadId:text(r.threadId)||undefined,from:text(r.from,2000),to:list(r.to).map(v=>text(v,2000)),subject:text(r.subject,2000),body:text(r.extractedText || r.text),snippet:text(r.preview,1000),timestamp:r.timestamp instanceof Date ? r.timestamp.toISOString() : text(r.timestamp)||undefined};
}
function canonicalSend(value: PreparedSend): PreparedSend {
 if(value.operation!=='send_email' || !['gmail','agentmail'].includes(value.provider)) throw new ConnectorError('invalid_input');
 const to=list(value.to).map(v=>required(v,320));
 if(!to.length || to.length>50 || to.some(v=>! /^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(v))) throw new ConnectorError('invalid_input');
 const subject=required(value.subject,998), body=value.body;
 if(typeof body!=='string' || !body.trim() || body.length>100000 || body.includes('\0')) throw new ConnectorError('invalid_input');
 return Object.freeze({operation:'send_email',provider:value.provider,userId:required(value.userId),accountId:required(value.accountId),to:Object.freeze(to),subject,body});
}
export function createConnectors(options: ConnectorOptions) {
 const userId=required(options.userId);
 const composio=()=> {if(!options.composio) throw new ConnectorError('not_configured'); return options.composio;};
 const agentmail=()=> {if(!options.agentmail) throw new ConnectorError('not_configured'); return options.agentmail;};
 const inboxId=()=>required(options.agentMailInboxId || (()=>{throw new ConnectorError('not_configured');})());
 const authConfig=(toolkit:Toolkit)=>toolkit==='gmail' ? options.gmailAuthConfigId : options.calendarAuthConfigId;
 async function accounts(toolkit:Toolkit) {
  const items:Record<string,unknown>[]=[]; let cursor:string|undefined;
  for(let page=0;page<10;page++) {
   const result=record(await safe(()=>composio().listAccounts({userIds:[userId],toolkitSlugs:[toolkit],...(authConfig(toolkit) ? {authConfigIds:[authConfig(toolkit)!]} : {}),accountType:'PRIVATE',limit:100,...(cursor ? {cursor} : {})})));
   items.push(...list(result.items).map(record).filter(r=>record(r.toolkit).slug===toolkit && (!authConfig(toolkit) || record(r.authConfig).id===authConfig(toolkit))));
   cursor=text(result.nextCursor)||undefined; if(!cursor) return items;
  } throw new ConnectorError('invalid_response');
 }
 async function activeAccount(toolkit:Toolkit) {
  const selected=toolkit==='gmail' ? options.gmailConnectedAccountId : options.calendarConnectedAccountId;
  const all=(await accounts(toolkit)).filter(r=>r.status==='ACTIVE' && r.isDisabled!==true);
  const matching=selected ? all.filter(r=>r.id===selected) : all;
  if(!matching.length) throw new ConnectorError('not_connected'); if(matching.length!==1) throw new ConnectorError('ambiguous_account');
  return required(matching[0]!.id);
 }
 async function google(request:ProxyRequest) {return response(await safe(()=>composio().proxy(request)));}
 const capabilities={
  async connectionStatus() {
   const states: Array<{toolkit:Toolkit;configured:boolean;accounts:Array<{id:string;status:string}>}> = [];
   for(const toolkit of ['gmail','googlecalendar'] as const) states.push({toolkit,configured:Boolean(options.composio),accounts:options.composio ? (await accounts(toolkit)).map(r=>({id:required(r.id),status:text(r.status,32)})) : []});
   return {userId,personal:states,agentMail:{configured:Boolean(options.agentmail),inboxId:options.agentMailInboxId}};
  },
  async initiateConnection(input:{toolkit:Toolkit;callbackUrl:string}) {
   if(input.toolkit!=='gmail' && input.toolkit!=='googlecalendar') throw new ConnectorError('invalid_input');
   const callback=new URL(input.callbackUrl); if(callback.protocol!=='https:' && !(callback.protocol==='http:' && ['localhost','127.0.0.1'].includes(callback.hostname))) throw new ConnectorError('invalid_input');
   const r=record(await safe(()=>composio().authorize(userId,input.toolkit,{callbackUrl:callback.toString(),...(authConfig(input.toolkit) ? {authConfigId:authConfig(input.toolkit)} : {})})));
   const redirectUrl=required(r.redirectUrl,4096); const redirect=new URL(redirectUrl);
   if(redirect.protocol!=='https:' || redirect.hostname!=='connect.composio.dev') throw new ConnectorError('invalid_response');
   return {toolkit:input.toolkit,connectionId:required(r.id),redirectUrl};
  },
  async readMail(input:{query?:string;limit?:number}={}) {
   const count=limit(input.limit), accountId=await activeAccount('gmail');
   const parameters:NonNullable<ProxyRequest['parameters']>=[{in:'query',name:'maxResults',value:count}];
   if(input.query) parameters.push({in:'query',name:'q',value:required(input.query,2000)});
   const page=await google({endpoint:'https://gmail.googleapis.com/gmail/v1/users/me/messages',method:'GET',connectedAccountId:accountId,parameters});
   const messages:MailMessage[]=[];
   for(const item of list(page.messages).slice(0,count)) {
    const id=required(record(item).id); const result=await google({endpoint:`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(id)}`,method:'GET',connectedAccountId:accountId,parameters:[{in:'query',name:'format',value:'full'}]});
    messages.push(gmailMessage(result));
   } return {provider:'gmail' as const,accountId,messages,nextPageToken:text(page.nextPageToken)||undefined};
  },
  async readCalendar(input:{timeMin:string;timeMax:string;calendarId?:string;limit?:number}) {
   const start=Date.parse(input.timeMin),end=Date.parse(input.timeMax);
   if(!Number.isFinite(start) || !Number.isFinite(end) || start>=end || !/T.*(Z|[+-]\d{2}:\d{2})$/.test(input.timeMin) || !/T.*(Z|[+-]\d{2}:\d{2})$/.test(input.timeMax)) throw new ConnectorError('invalid_input');
   const accountId=await activeAccount('googlecalendar'),calendarId=required(input.calendarId ?? 'primary');
   const r=await google({endpoint:`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`,method:'GET',connectedAccountId:accountId,parameters:[{in:'query',name:'timeMin',value:new Date(start).toISOString()},{in:'query',name:'timeMax',value:new Date(end).toISOString()},{in:'query',name:'singleEvents',value:'true'},{in:'query',name:'orderBy',value:'startTime'},{in:'query',name:'maxResults',value:limit(input.limit)}]});
   return {accountId,calendarId,events:list(r.items).slice(0,limit(input.limit)).map(v=>{const e=record(v);return {id:required(e.id),summary:text(e.summary,1000),description:text(e.description),location:text(e.location,2000),start:text(record(e.start).dateTime || record(e.start).date),end:text(record(e.end).dateTime || record(e.end).date),status:text(e.status,32),attendees:list(e.attendees).slice(0,100).map(v=>({email:text(record(v).email,320),responseStatus:text(record(v).responseStatus,32)}))};}),nextPageToken:text(r.nextPageToken)||undefined};
  },
  prepareAgentInbox(input:{displayName:string;clientId:string}):PreparedInbox {
   agentmail();
   if(!options.agentMailProvisioningAccountId) throw new ConnectorError('not_configured');
   return Object.freeze({operation:'create_inbox',provider:'agentmail',userId,accountId:required(options.agentMailProvisioningAccountId),displayName:required(input.displayName,200),clientId:required(input.clientId,100)});
  },
  async createAgentInbox(input:PreparedInbox,authorization:SendAuthorization):Promise<InboxReceipt> {
   if(input.operation!=='create_inbox' || input.provider!=='agentmail' || input.userId!==userId || input.accountId!==options.agentMailProvisioningAccountId) throw new ConnectorError('scope_mismatch');
   const envelope=Object.freeze({operation:'create_inbox' as const,provider:'agentmail' as const,userId,accountId:required(input.accountId),displayName:required(input.displayName,200),clientId:required(input.clientId,100)});
   required(authorization.approvalId); required(authorization.idempotencyKey);
   if(!options.approval) throw new ConnectorError('approval_required');
   return options.approval.run(envelope,authorization,async()=>{ const r=record(await safe(()=>agentmail().createInbox({displayName:envelope.displayName,clientId:envelope.clientId}))); return {provider:'agentmail',accountId:envelope.accountId,inboxId:required(r.inboxId)}; });
  },
  async readAgentInbox() { const id=inboxId(),r=record(await safe(()=>agentmail().getInbox(id))); if(r.inboxId!==id) throw new ConnectorError('scope_mismatch'); return {inboxId:id,displayName:text(r.displayName,200)}; },
  async readAgentMail(input:{limit?:number}={}) { const id=inboxId(),count=limit(input.limit); const r=record(await safe(()=>agentmail().listMessages(id,{limit:count}))); return {inboxId:id,messages:list(r.messages).slice(0,count).map(agentMessage),nextPageToken:text(r.nextPageToken)||undefined}; },
  async readAgentReply(input:{messageId:string}) { const id=inboxId(),messageId=required(input.messageId); return agentMessage(await safe(()=>agentmail().getMessage(id,messageId))); },
  async prepareSend(input:{provider:MailProvider;to:readonly string[];subject:string;body:string}):Promise<PreparedSend> {
   if(input.provider!=='gmail' && input.provider!=='agentmail') throw new ConnectorError('invalid_input');
   // Validate headers/body before doing even a provider read.
   const preliminary=canonicalSend({operation:'send_email',userId,accountId:'pending',...input});
   const accountId=input.provider==='gmail' ? await activeAccount('gmail') : inboxId();
   if(input.provider==='agentmail') agentmail();
   return canonicalSend({...preliminary,accountId});
  },
  async sendPrepared(input:PreparedSend, authorization:SendAuthorization):Promise<SendReceipt> {
   const envelope=canonicalSend(input);
   if(envelope.userId!==userId || envelope.provider==='agentmail' && envelope.accountId!==inboxId()) throw new ConnectorError('scope_mismatch');
   required(authorization.approvalId); required(authorization.idempotencyKey);
   if(!options.approval) throw new ConnectorError('approval_required');
   return options.approval.run(envelope,authorization,async()=>{
    if(envelope.provider==='gmail') {
     // A changed/revoked connection cannot redirect an already-approved message.
     if(await activeAccount('gmail')!==envelope.accountId) throw new ConnectorError('scope_mismatch');
     const mime=`To: ${envelope.to.join(', ')}\r\nSubject: =?UTF-8?B?${Buffer.from(envelope.subject).toString('base64')}?=\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${Buffer.from(envelope.body).toString('base64').replace(/.{1,76}/g,'$&\r\n')}`;
     const r=await google({endpoint:'https://gmail.googleapis.com/gmail/v1/users/me/messages/send',method:'POST',connectedAccountId:envelope.accountId,body:{raw:Buffer.from(mime).toString('base64url')}});
     return {provider:'gmail',accountId:envelope.accountId,messageId:required(r.id),...(text(r.threadId) ? {threadId:text(r.threadId)} : {})};
    }
    const r=record(await safe(()=>agentmail().sendMessage(envelope.accountId,{to:[...envelope.to],subject:envelope.subject,text:envelope.body})));
    return {provider:'agentmail',accountId:envelope.accountId,messageId:required(r.messageId),...(text(r.threadId) ? {threadId:text(r.threadId)} : {})};
   });
  },
 };
 return capabilities;
}
export type ConnectorCapabilities=ReturnType<typeof createConnectors>;
