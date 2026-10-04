import test from 'node:test';
import assert from 'node:assert/strict';
import { createSdkConnectors } from './sdk.ts';
import { ConnectorError } from './index.ts';
import type { ApprovedExecutor } from './index.ts';
const approval:ApprovedExecutor={run:async(_envelope,_auth,dispatch)=>dispatch()};

test('real AgentMail SDK uses configured inbox and never retries a failed send',async()=>{
 const original=globalThis.fetch; const calls:Array<{url:string;body:unknown}>=[]; let fail=false;
 globalThis.fetch=async(input,init)=>{
  const request=input instanceof Request ? input : new Request(input,init);
  calls.push({url:request.url,body:request.method==='POST' ? JSON.parse(await request.text()) : undefined});
  if(fail) return new Response(JSON.stringify({error:'upstream secret'}),{status:503,headers:{'content-type':'application/json'}});
  return new Response(JSON.stringify({message_id:'real-sdk-msg',thread_id:'real-sdk-thread'}),{status:200,headers:{'content-type':'application/json'}});
 };
 try{
  const c=await createSdkConnectors({userId:'local-user',approval,env:{AGENTMAIL_API_KEY:'test-only-key',AGENTMAIL_INBOX_ID:'agent@agentmail.to'}});
  assert.equal(calls.length,0);
  const p=await c.prepareSend({provider:'agentmail',to:['recipient@example.com'],subject:'Hi',body:'Hello'});
  const result=await c.sendPrepared(p,{approvalId:'test',idempotencyKey:'test'});
  assert.equal(result.messageId,'real-sdk-msg'); assert.match(calls[0]!.url,/\/inboxes\/agent%40agentmail.to\/messages\/send$/);
  assert.deepEqual(calls[0]!.body,{to:['recipient@example.com'],subject:'Hi',text:'Hello'});
  fail=true; const before=calls.length;
  await assert.rejects(()=>c.sendPrepared(p,{approvalId:'test2',idempotencyKey:'test2'}),(e:unknown)=>e instanceof ConnectorError && e.code==='provider_error' && !e.message.includes('secret'));
  assert.equal(calls.length-before,1);
 }finally{globalThis.fetch=original;}
});
test('real Composio SDK scopes account query and proxy request to selected user',async()=>{
 const original=globalThis.fetch; const previousTelemetry=process.env.TELEMETRY_DISABLED;
 process.env.TELEMETRY_DISABLED='true'; let failSend=false; const calls:Array<{url:string;body:Record<string,unknown>}> = [];
 globalThis.fetch=async(input,init)=>{
  const request=input instanceof Request ? input : new Request(input,init);
  const body=request.method==='POST' ? JSON.parse(await request.text()) : {};
  calls.push({url:request.url,body});
  if(failSend && request.url.includes('/tools/execute/proxy')) return new Response(JSON.stringify({error:'secret'}),{status:503,headers:{'content-type':'application/json'}});
  let data:unknown;
  if(request.url.includes('connected_accounts')) data={items:[{id:'ca_scoped',status:'ACTIVE',status_reason:null,toolkit:{slug:'gmail'},auth_config:{id:'ac_gmail',is_composio_managed:true,is_disabled:false},is_disabled:false,created_at:'2026-10-04T00:00:00Z',updated_at:'2026-10-04T00:00:00Z'}],next_cursor:null,total_pages:1};
  else if(request.url.includes('/tools/execute/proxy')) data={status:200,headers:{},data:{messages:[]}};
  else throw new Error(`Unexpected mocked SDK request ${new URL(request.url).pathname}`);
  return new Response(JSON.stringify(data),{status:200,headers:{'content-type':'application/json'}});
 };
 try{
  const c=await createSdkConnectors({userId:'local-user',approval,env:{COMPOSIO_API_KEY:'test-only-key',COMPOSIO_GMAIL_AUTH_CONFIG_ID:'ac_gmail'}});
  assert.equal(calls.length,0); const result=await c.readMail({limit:1}); assert.equal(result.accountId,'ca_scoped');
  assert.equal(new URL(calls[0]!.url).searchParams.get('user_ids'),'local-user');
  assert.equal(new URL(calls[0]!.url).searchParams.get('toolkit_slugs'),'gmail');
  assert.equal(calls[1]!.body.connected_account_id,'ca_scoped');
  assert.equal(calls[1]!.body.endpoint,'https://gmail.googleapis.com/gmail/v1/users/me/messages');
  const prepared=await c.prepareSend({provider:'gmail',to:['recipient@example.com'],subject:'Unicode café',body:'Body'});
  failSend=true; const count=calls.filter(x=>x.url.includes('/tools/execute/proxy')).length;
  await assert.rejects(()=>c.sendPrepared(prepared,{approvalId:'a',idempotencyKey:'k'}),(e:unknown)=>e instanceof ConnectorError && e.code==='provider_error');
  assert.equal(calls.filter(x=>x.url.includes('/tools/execute/proxy')).length-count,1);
 }finally{globalThis.fetch=original;if(previousTelemetry===undefined)delete process.env.TELEMETRY_DISABLED;else process.env.TELEMETRY_DISABLED=previousTelemetry;}
});
