import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import type { Server } from 'node:http';
import { createNeonService } from './server.ts';
import { createConnectors } from '../../integrations/connectors/index.ts';
import { openVault, registerContext } from '../../packages/vault/store.js';
import { loadWorld } from '../../packages/vault/world.js';
import { importPeopleSource, selectPeopleSources } from '../../packages/organs/people.js';
import { readPeopleWorkspace } from '../../packages/vault/people-edits.js';

const roots:string[]=[],servers:Server[]=[];
afterEach(async()=>{for(const server of servers.splice(0)){server.closeAllConnections();await new Promise<void>(yes=>server.close(()=>yes()));}for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
function vaultFixture(){
 const directory=mkdtempSync(join(tmpdir(),'neon-http-'));roots.push(directory);
 const vaultDirectory=join(directory,'vault'),vault=openVault(vaultDirectory);
 registerContext(vault,{id:'W',name:'Fixture World',kind:'social',anchor:'email',created_at:'2026-10-04T00:00:00Z'});
 const source={platform:'fixture',accountId:'local',eventId:'dinner',name:'Earlier dinner',date:'2026-09-01',url:'https://example.test/event',evidence:['fixture:roster']};
 selectPeopleSources(vault,{contextId:'W',viewId:'people',viewName:'People',sources:[source],discoveryComplete:true});
 const view=importPeopleSource(vault,{contextId:'W',viewId:'people',source,readState:'read',evidence:['fixture:roster'],rows:[{rowId:'1',name:'Avery',evidence:['fixture:row1']},{rowId:'2',name:'Riley',evidence:['fixture:row2']}]});
 return {directory,vaultDirectory,ids:view.people.map(p=>p.personId),world:()=>loadWorld(openVault(vaultDirectory))};
}
const env={NEON_DEMO_RECIPIENT:'controlled@example.test',NEON_AI_GATEWAY_TOKEN:'fixture-token',NEON_AI_GATEWAY_BASE_URL:'https://fixture.example.test',NEON_MODEL:'fixture',AGENTMAIL_API_KEY:'fixture-key',AGENTMAIL_INBOX_ID:'fixture-inbox'};
async function fixture({ready=true,uncertain=false,inbox='fixture-inbox'}={}){
 const source=vaultFixture(),send=vi.fn(async(_inboxId:string,_payload:{to:string[];subject:string;text:string})=>{if(uncertain)throw new Error('private-key-provider-error');return {messageId:'fixture-receipt'};});
 const connectorsFactory=vi.fn(async({userId,approval,env:connectorEnv}:Parameters<NonNullable<Parameters<typeof createNeonService>[0]['connectorsFactory']>>[0])=>createConnectors({userId,approval,agentMailInboxId:connectorEnv.AGENTMAIL_INBOX_ID,agentMailProvisioningAccountId:'agentmail-key:'+createHash('sha256').update(env.AGENTMAIL_API_KEY).digest('hex'),agentmail:{getInbox:async()=>({inboxId:'fixture-inbox'}),listMessages:async()=>({messages:[{messageId:'reply',from:'controlled@example.test',to:['agent@example.test'],text:'Fixture reply',subject:'Re: invite'}]}),getMessage:async()=>({messageId:'reply',text:'Fixture reply'}),sendMessage:send,createInbox:async()=>({inboxId:'created'})}}));
 const runtimeFactory=vi.fn(async(_options:Parameters<NonNullable<Parameters<typeof createNeonService>[0]['runtimeFactory']>>[0])=>({pending:async()=>[],cancel:()=>false,handleRun:async()=>new Response('data: {"type":"RUN_FINISHED"}\n\n',{headers:{'Content-Type':'text/event-stream'}})}));
 const options={...source,env:{...env,AGENTMAIL_INBOX_ID:inbox},ready:()=>ready,connectorsFactory,runtimeFactory};
 const service=createNeonService(options);servers.push(service);service.listen(0,'127.0.0.1');await once(service,'listening');
 const port=(service.address() as {port:number}).port;
 const call=async(path:string,input?:unknown,extra:RequestInit={})=>fetch(`http://127.0.0.1:${port}/api/neon${path}`,{...(input===undefined?{}:{method:'POST',headers:{Origin:'http://localhost:5299','Content-Type':'application/json'},body:JSON.stringify(input)}),...extra});
 const execute=async(id:string,input:unknown)=>{const tool=service.neon.capabilities().find(t=>t.id===id)!;return tool.execute(input,{signal:undefined,threadId:'fixture-thread',resourceId:'neon-local',toolCallId:'fixture-call'});};
 const prepare=async()=>{await execute('set_goal',{text:'Bring these two actual fixture people together'});const people=(await execute('read_local_people',{}) as {people:{id:string;sources:string[]}[]}).people;await execute('set_shortlist',{people:people.map(p=>({personId:p.id,rationale:'Existing fixture roster evidence',sources:[p.sources[0]]}))});await execute('select_people',{personIds:[source.ids[0]]});return execute('prepare_invitation',{provider:'agentmail',subject:'Fixture invitation',body:'An actual fixture invitation.'}) as Promise<{id:string;hash:string;payload:unknown}>;};
 return {...source,service,send,connectorsFactory,runtimeFactory,call,execute,prepare,options};
}
describe('Neon loopback service with actual approval ledger and local connector transport',()=>{
 it('does not import or construct live runtimes with keys present but readiness absent',async()=>{
  const f=await fixture({ready:false});const response=await f.call('/status?threadId=fixture-thread');expect(response.status).toBe(200);expect(await response.json()).toMatchObject({configured:{provider:false,agentmail:false},keysReady:false,pending:[],nativeInterrupts:[]});
  expect((await f.call('/people')).status).toBe(200);expect((await f.call('/agent',{threadId:'fixture-thread'})).status).toBe(503);expect((await f.call('/connections/gmail',{})).status).toBe(503);
  expect(f.connectorsFactory).not.toHaveBeenCalled();expect(f.runtimeFactory).not.toHaveBeenCalled();expect(f.send).not.toHaveBeenCalled();
 });
 it('bounds bodies and requires exact local host, origin and JSON before a mutation',async()=>{
  const f=await fixture();
  const {request}=await import('node:http');const port=(f.service.address() as {port:number}).port;const foreign=await new Promise<number>(yes=>{request({host:'127.0.0.1',port,path:'/api/neon/status',headers:{Host:'attacker.example:5275'}},r=>{r.resume();yes(r.statusCode!);}).end();});expect(foreign).toBe(403);
  expect((await f.call('/agent',{}, {headers:{Origin:'https://attacker.example','Content-Type':'application/json'}})).status).toBe(403);
  expect((await f.call('/agent',{}, {headers:{'Content-Type':'application/json'}})).status).toBe(403);
  expect((await f.call('/agent',{}, {headers:{Origin:'http://localhost:5299','Content-Type':'text/plain'}})).status).toBe(415);
  expect((await f.call('/agent',{value:'x'.repeat(129*1024)})).status).toBe(413);
  expect(f.runtimeFactory).not.toHaveBeenCalled();
 });
 it('prepares without sending, revokes edits, rejects stale approvals and replays the persisted receipt once',async()=>{
  const f=await fixture(),draft=await f.prepare();expect(f.send).not.toHaveBeenCalled();expect(f.service.neon.capabilities().some(t=>/send|approve/.test(t.id))).toBe(false);
  const initial=await (await f.call('/status')).json();expect(initial.pending[0]).toMatchObject({id:draft.id,payload:{accountId:'fixture-inbox',userId:'neon-local',to:['controlled@example.test']}});
  expect((await f.call(`/approvals/${draft.id}`,{hash:draft.hash,body:'forged'})).status).toBe(400);
  expect((await f.call(`/drafts/${draft.id}`,{to:['other@example.test'],subject:'Changed',body:'Changed'})).status).toBe(409);
  const replacement=await (await f.call(`/drafts/${draft.id}`,{to:['controlled@example.test'],subject:'Reviewed edit',body:'Reviewed exact message'})).json();expect(replacement.id).not.toBe(draft.id);
  expect((await f.call(`/approvals/${draft.id}`,{hash:draft.hash})).status).toBe(409);
  expect((await f.call(`/approvals/${replacement.id}`,{hash:draft.hash})).status).toBe(409);
  expect((await f.call(`/approvals/${replacement.id}`,{hash:replacement.hash})).status).toBe(200);
  expect((await f.call(`/approvals/${replacement.id}`,{hash:replacement.hash})).status).toBe(200);
  expect(f.send).toHaveBeenCalledTimes(1);expect(f.send.mock.calls[0]?.[1]).toEqual({to:['controlled@example.test'],subject:'Reviewed edit',text:'Reviewed exact message'});
  const after=await (await f.call('/status')).json();expect(after.pending).toEqual([]);expect(after.receipts).toMatchObject([{status:'complete',receipt:{messageId:'fixture-receipt'}}]);
  expect((await f.call(`/drafts/${replacement.id}`,undefined,{method:'DELETE',headers:{Origin:'http://localhost:5299'}})).status).toBe(409);
  expect((await f.call('/approvals/missing',{hash:draft.hash})).status).toBe(404);
  const reopened=createNeonService(f.options);servers.push(reopened);reopened.listen(0,'127.0.0.1');await once(reopened,'listening');const port=(reopened.address() as {port:number}).port;
  const replay=await fetch(`http://127.0.0.1:${port}/api/neon/approvals/${replacement.id}`,{method:'POST',headers:{Origin:'http://localhost:5299','Content-Type':'application/json'},body:JSON.stringify({hash:replacement.hash})});expect(replay.status).toBe(200);expect(f.send).toHaveBeenCalledTimes(1);
 });
 it('does not retry an uncertain provider outcome and does not leak raw provider errors',async()=>{
  const f=await fixture({uncertain:true}),draft=await f.prepare();const result=await f.call(`/approvals/${draft.id}`,{hash:draft.hash});expect(result.status).toBe(409);expect(await result.text()).not.toContain('private-key');
  expect((await f.call(`/approvals/${draft.id}`,{hash:draft.hash})).status).toBe(409);expect(f.send).toHaveBeenCalledTimes(1);
  const status=await (await f.call('/status')).json();expect(status.pending).toEqual([]);expect(status.receipts[0].status).toBe('uncertain');
 });
 it('exposes native approval tools and leaves invitation dispatch unavailable to the model',async()=>{
  const f=await fixture();for(const id of ['enrich_person','research_page','normalize_csv','discover_research_tools','execute_research_tool','share_event_snapshot'])expect(f.service.neon.capabilities().find(t=>t.id===id)?.requiresApproval).toBe(true);
  const stream=await f.call('/agent',{threadId:'fixture-thread'});expect(stream.headers.get('content-type')).toBe('text/event-stream');expect(await stream.text()).toContain('RUN_FINISHED');expect(f.runtimeFactory).toHaveBeenCalledOnce();expect(f.send).not.toHaveBeenCalled();
  const {NEON_CORE_TOOL_IDS}=await import('./capabilities.ts');const runtimeOptions=f.runtimeFactory.mock.calls[0]?.[0] as unknown as {tools:{id:string}[];instructions:string};expect(new Set(runtimeOptions.tools.map(t=>t.id))).toEqual(NEON_CORE_TOOL_IDS);expect(runtimeOptions.instructions).toContain('external research, inbox and sending capabilities are not enabled');
 });
 it('preserves the actual post-it workspace order, note snapshots, replies and wave completion',async()=>{
  const f=await fixture();const scope={contextId:'W',viewId:'people'};
  expect(await (await f.call('/people-workspace')).json()).toMatchObject({ok:true,views:[{contextId:'W',viewId:'people'}]});
  const save=await f.call('/people-workspace/note',{...scope,requestId:'note',noteId:'n1',personId:f.ids[0],text:'Move me below Riley',state:'draft',baseRevision:0});expect(save.status).toBe(200);
  const wave=await (await f.call('/people-workspace/waves',{...scope,requestId:'wave',noteIds:['n1']})).json();const waveId=wave.result.waveId;
  const read=await f.execute('people_read',{...scope,waveId,includeEvidence:true});
  await f.execute('set_goal',{text:'Choose two from the actual saved roster'});const roster=await f.execute('people_read',{...scope,includeEvidence:true}) as {people:{personId:string;memberships:{sourceId:string}[]}[]};
  expect(await f.execute('set_shortlist',{contextId:scope.contextId,people:roster.people.map(p=>({personId:p.personId,rationale:'Present in the existing roster',sources:[p.memberships[0].sourceId]}))})).toMatchObject({shortlist:expect.any(Array)});
  await expect(f.execute('set_shortlist',{contextId:scope.contextId,people:[{personId:roster.people[0].personId,rationale:'Unverified source',sources:['invented-source-id']}]})).rejects.toThrow('does not belong');
  expect(read).toMatchObject({ok:true,wave:{notes:[{noteId:'n1',text:'Move me below Riley'}]}});
  expect(await f.execute('people_finish_notes',{...scope,waveId,status:'completed',requestId:'premature'})).toMatchObject({ok:false,unansweredNoteIds:['n1']});
  expect(await f.execute('people_order',{...scope,waveId,personIds:[f.ids[1],f.ids[0]],baseRevision:0,requestId:'reorder'})).toMatchObject({ok:true});
  expect(await f.execute('people_reply',{...scope,waveId,noteId:'r1',replyTo:'n1',personId:f.ids[0],text:'Saved the requested order',baseRevision:0,requestId:'reply'})).toMatchObject({ok:true});
  expect(await f.execute('people_finish_notes',{...scope,waveId,status:'completed',requestId:'finished'})).toMatchObject({ok:true});
  const stored=readPeopleWorkspace(f.world(),'W','people')!;expect(stored.order).toEqual([f.ids[1],f.ids[0]]);expect(stored.waves[0].status).toBe('completed');expect(stored.waves[0].notes[0].text).toBe('Move me below Riley');
  const reopen=createNeonService(f.options);servers.push(reopen);expect(await reopen.neon.capabilities().find(t=>t.id==='people_read')!.execute({...scope,waveId},{signal:undefined,threadId:'fixture-thread',resourceId:'neon-local',toolCallId:'read'})).toMatchObject({wave:{status:'completed'}});
 });
 it('persists the separately approved created inbox and binds it only to the same credential account',async()=>{
  const f=await fixture({inbox:''});const draft=await f.execute('prepare_agent_inbox',{displayName:'Fixture agent inbox'}) as {id:string;hash:string};
  expect((await f.call(`/approvals/${draft.id}`,{hash:draft.hash})).status).toBe(200);
  expect(await (await f.call('/status')).json()).toMatchObject({agentInboxId:'created'});
  await f.execute('read_agent_reply',{});expect(f.connectorsFactory.mock.calls.at(-1)?.[0].env.AGENTMAIL_INBOX_ID).toBe('created');
  const reopened=createNeonService({...f.options,env:{...f.options.env,AGENTMAIL_API_KEY:'another-fixture-key'}});servers.push(reopened);reopened.listen(0,'127.0.0.1');await once(reopened,'listening');const port=(reopened.address() as {port:number}).port;expect(await (await fetch(`http://127.0.0.1:${port}/api/neon/status`)).json()).toMatchObject({agentInboxId:null});
 });
 it('restores pending native interrupts from disk without initializing providers',async()=>{
  const f=await fixture({ready:false});const {createHash}=await import('node:crypto');const {mkdirSync}=await import('node:fs');const directory=join(f.directory,'agent','threads');mkdirSync(directory,{recursive:true});const key=createHash('sha256').update(JSON.stringify({resourceId:'neon-local',threadId:'fixture-thread'})).digest('hex');writeFileSync(join(directory,key+'.json'),JSON.stringify({pending:[{id:'interrupt',reason:'mastra:tool_approval'}]}));
  expect(await (await f.call('/status?threadId=fixture-thread')).json()).toMatchObject({nativeInterrupts:[{id:'interrupt'}]});expect(f.runtimeFactory).not.toHaveBeenCalled();
  expect(await (await f.call('/agent/thread?threadId=fixture-thread')).json()).toMatchObject({messages:[],pending:[{id:'interrupt'}],state:{}});
 });
});
