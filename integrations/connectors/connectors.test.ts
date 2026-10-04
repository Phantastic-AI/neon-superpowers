import test from 'node:test';
import assert from 'node:assert/strict';
import { createConnectors, ConnectorError } from './index.ts';

function fixture(overrides: Record<string, unknown> = {}) {
  const calls: Array<[string, unknown]> = [];
  const composio = {
    listAccounts: async (query: unknown) => { calls.push(['accounts', query]); return {items:[{id:'ca_me',status:'ACTIVE',toolkit:{slug:'gmail'},authConfig:{id:'ac_gmail'},isDisabled:false}],nextCursor:null}; },
    authorize: async (user: string, toolkit: string, options: unknown) => { calls.push(['authorize',{user,toolkit,options}]); return {id:'ca_new',redirectUrl:'https://connect.composio.dev/link/a'}; },
    proxy: async (request: unknown) => { calls.push(['proxy', request]); return {status:200,data:{messages:[{id:'msg1'}],id:'msg1',threadId:'thread1',snippet:'Hello',payload:{headers:[{name:'Subject',value:'Test'}]},access_token:'DO_NOT_RETURN'}}; },
  };
  const agentmail = {
    getInbox: async (id: string) => { calls.push(['inbox',id]); return {inboxId:id,displayName:'Agent',secret:'HIDDEN'}; },
    createInbox: async (request: unknown) => { calls.push(['createInbox',request]); return {inboxId:'new@agentmail.to'}; },
    listMessages: async (id: string, options: unknown) => { calls.push(['messages',{id,options}]); return {messages:[{messageId:'am1',threadId:'t1',from:'a@example.com',to:['agent@agentmail.to'],subject:'Reply',extractedText:'New answer',text:'New answer\nquoted history',secret:'HIDDEN'}]}; },
    getMessage: async (id: string, messageId: string) => { calls.push(['message',{id,messageId}]); return {messageId,extractedText:'New answer',html:'<script>bad</script>'}; },
    sendMessage: async (id: string, payload: unknown) => { calls.push(['send',{id,payload}]); return {messageId:'sent1',threadId:'t1',secret:'HIDDEN'}; },
  };
  const connectors = createConnectors({userId:'local-user',gmailAuthConfigId:'ac_gmail',agentMailInboxId:'agent@agentmail.to',composio,agentmail,...overrides});
  return {calls,connectors,composio,agentmail};
}

test('Gmail reads select only one private user-owned account and redact provider state',async()=>{
 const {connectors,calls}=fixture(); const result=await connectors.readMail({query:'is:unread',limit:2});
 assert.deepEqual(result.messages.map(m=>m.id),['msg1']);
 assert.deepEqual(calls[0]?.[1],{userIds:['local-user'],toolkitSlugs:['gmail'],authConfigIds:['ac_gmail'],accountType:'PRIVATE',limit:100});
 assert.equal(JSON.stringify(result).includes('DO_NOT_RETURN'),false);
 assert.equal((calls[1]?.[1] as Record<string,unknown>).connectedAccountId,'ca_me');
});
test('multiple accounts cannot silently select the first account',async()=>{
 const f=fixture(); f.composio.listAccounts=async()=>({items:[{id:'ca_1',status:'ACTIVE',toolkit:{slug:'gmail'},authConfig:{id:'ac_gmail'},isDisabled:false},{id:'ca_2',status:'ACTIVE',toolkit:{slug:'gmail'},authConfig:{id:'ac_gmail'},isDisabled:false}],nextCursor:null});
 await assert.rejects(()=>f.connectors.readMail(),(e: unknown)=>e instanceof ConnectorError && e.code==='ambiguous_account');
 assert.equal(f.calls.some(c=>c[0]==='proxy'),false);
});
test('AgentMail reads and replies are limited to configured inbox and plain text',async()=>{
 const f=fixture(); const inbox=await f.connectors.readAgentMail({limit:3}); const reply=await f.connectors.readAgentReply({messageId:'am1'});
 assert.equal(inbox.messages[0]?.body,'New answer'); assert.equal(reply.body,'New answer');
 assert.equal(JSON.stringify(inbox).includes('HIDDEN'),false);
 assert.deepEqual(f.calls[0]?.[1],{id:'agent@agentmail.to',options:{limit:3}});
});
test('denied approval never invokes provider send',async()=>{
 const f=fixture({approval:{run:async()=>{throw new Error('approval denied');}}});
 const prepared=await f.connectors.prepareSend({provider:'agentmail',to:['recipient@example.com'],subject:'Hi',body:'Body'});
 await assert.rejects(()=>f.connectors.sendPrepared(prepared,{approvalId:'a',idempotencyKey:'k'}));
 assert.equal(f.calls.some(c=>c[0]==='send'),false);
});
test('approval executor owns replay and receives immutable exact envelope',async()=>{
 let receipt: unknown; let seen: unknown; const f=fixture({approval:{run:async(envelope: unknown,authorization: unknown,dispatch:()=>Promise<unknown>)=>{seen={envelope,authorization}; return receipt ??=await dispatch();}}});
 const prepared=await f.connectors.prepareSend({provider:'agentmail',to:['recipient@example.com'],subject:'Hi',body:'Body'});
 assert.equal(Object.isFrozen(prepared),true); assert.equal(Object.isFrozen(prepared.to),true);
 const auth={approvalId:'a',idempotencyKey:'k'}; const first=await f.connectors.sendPrepared(prepared,auth); const second=await f.connectors.sendPrepared(prepared,auth);
 assert.deepEqual(first,second); assert.equal(f.calls.filter(c=>c[0]==='send').length,1); assert.deepEqual((seen as {authorization:unknown}).authorization,auth);
});
test('provider errors cannot leak secret bodies and failed sends are not retried',async()=>{
 const f=fixture({approval:{run:async(_e: unknown,_a: unknown,dispatch:()=>Promise<unknown>)=>dispatch()}}); let attempted=0;
 f.agentmail.sendMessage=async()=>{attempted++;throw Object.assign(new Error('token=secret'),{statusCode:429,body:{api_key:'secret'}});};
 const prepared=await f.connectors.prepareSend({provider:'agentmail',to:['recipient@example.com'],subject:'Hi',body:'Body'});
 await assert.rejects(()=>f.connectors.sendPrepared(prepared,{approvalId:'a',idempotencyKey:'k'}),(e:unknown)=>e instanceof ConnectorError && e.code==='rate_limited' && !JSON.stringify(e).includes('secret'));
 assert.equal(attempted,1);
});
test('foreign-user send envelopes and header injection are rejected before dispatch',async()=>{
 const f=fixture();
 await assert.rejects(()=>f.connectors.prepareSend({provider:'gmail',to:['a@example.com\r\nBcc: x@example.com'],subject:'Hi',body:'Body'}));
 const prepared=await f.connectors.prepareSend({provider:'agentmail',to:['a@example.com'],subject:'Hi',body:'Body'});
 await assert.rejects(()=>f.connectors.sendPrepared({...prepared,userId:'other-user'},{approvalId:'a',idempotencyKey:'k'}));
 assert.equal(f.calls.some(c=>c[0]==='send'),false);
});

test('calendar uses exact calendar account and projects bounded event fields',async()=>{
 const f=fixture({calendarAuthConfigId:'ac_cal'});
 f.composio.listAccounts=async()=>({items:[{id:'ca_cal',status:'ACTIVE',toolkit:{slug:'googlecalendar'},authConfig:{id:'ac_cal'},isDisabled:false}],nextCursor:null});
 f.composio.proxy=async(request:unknown)=>{f.calls.push(['proxy',request]);return {status:200,data:{items:[{id:'e1',summary:'Meeting',start:{dateTime:'2026-10-04T10:00:00Z'},end:{dateTime:'2026-10-04T11:00:00Z'},secret:'HIDDEN'}]}} as never;};
 const result=await f.connectors.readCalendar({timeMin:'2026-10-04T00:00:00Z',timeMax:'2026-10-05T00:00:00Z'});
 assert.equal(result.accountId,'ca_cal');assert.equal(result.events[0]?.id,'e1');assert.equal(JSON.stringify(result).includes('HIDDEN'),false);
 assert.equal((f.calls[0]?.[1] as Record<string,unknown>).endpoint,'https://www.googleapis.com/calendar/v3/calendars/primary/events');
});
test('explicit connection ID cannot escape the scoped account query',async()=>{
 const f=fixture({gmailConnectedAccountId:'foreign-account'});
 await assert.rejects(()=>f.connectors.readMail(),(e:unknown)=>e instanceof ConnectorError && e.code==='not_connected');
 assert.equal(f.calls.some(c=>c[0]==='proxy'),false);
});
test('Composio proxy HTTP failures do not return upstream credential bodies',async()=>{
 const f=fixture(); f.composio.proxy=async()=>({status:403,data:{access_token:'LEAK'}} as never);
 await assert.rejects(()=>f.connectors.readMail(),(e:unknown)=>e instanceof ConnectorError && e.code==='unauthorized' && !JSON.stringify(e).includes('LEAK'));
});
test('inbox provisioning requires exact approved account and passes stable clientId',async()=>{
 const f=fixture({agentMailProvisioningAccountId:'credential-fingerprint',approval:{run:async(_e:unknown,_a:unknown,dispatch:()=>Promise<unknown>)=>dispatch()}});
 const prepared=f.connectors.prepareAgentInbox({displayName:'Neon',clientId:'local-agent-1'});
 const receipt=await f.connectors.createAgentInbox(prepared,{approvalId:'a',idempotencyKey:'k'});
 assert.equal(receipt.inboxId,'new@agentmail.to');assert.deepEqual(f.calls[0]?.[1],{displayName:'Neon',clientId:'local-agent-1'});
 await assert.rejects(()=>f.connectors.createAgentInbox({...prepared,accountId:'other-key'},{approvalId:'a',idempotencyKey:'k'}));
 assert.equal(f.calls.filter(c=>c[0]==='createInbox').length,1);
});
test('inbox provisioning denied by ledger never creates an inbox',async()=>{
 const f=fixture({agentMailProvisioningAccountId:'credential-fingerprint',approval:{run:async()=>{throw new Error('approval denied');}}});
 const prepared=f.connectors.prepareAgentInbox({displayName:'Neon',clientId:'local-agent-1'});
 await assert.rejects(()=>f.connectors.createAgentInbox(prepared,{approvalId:'a',idempotencyKey:'k'}));assert.equal(f.calls.length,0);
});
