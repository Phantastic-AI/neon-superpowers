import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { createLocalNeonAgentRuntime, createFileThreadStateStore, readNeonAgentConfig } from './index.ts';

const body=(runId:string,resume?:unknown)=>({threadId:'actual-thread',runId,messages:[{id:'user-1',role:'user',content:'Run the injected capability'}],tools:[],context:[],state:{},forwardedProps:{},...(resume?{resume}: {})});
const request=(runId:string,resume?:unknown)=>new Request('http://localhost/agent',{method:'POST',body:JSON.stringify(body(runId,resume))});
async function events(response:Response) {assert.equal(response.status,200);return (await response.text()).split('\n\n').filter(Boolean).map(line=>JSON.parse(line.replace(/^data: /,'')));}

function fixtureGateway(toolCount=1,model='fixture-model') {
 const originalFetch=globalThis.fetch;let calls=0;
 globalThis.fetch=async(url,options)=>{
  assert.equal(String(url),'https://fixture.ai.neon.tech/v1/chat/completions');
  const input=JSON.parse(options!.body as string);assert.equal(input.model,model);calls++;
  if(model==='gpt-5-6-luna' && input.tools?.length)assert.equal(input.reasoning_effort,'none','Neon Chat Completions requires explicit reasoning_effort none with function tools');
  const hasResult=input.messages.some((m:{role:string})=>m.role==='tool');
  const data=hasResult?[
   {id:'completion-2',object:'chat.completion.chunk',created:1,model:'fixture-model',choices:[{index:0,delta:{role:'assistant',content:'Fixture continuation complete'},finish_reason:null}]},
   {id:'completion-2',object:'chat.completion.chunk',created:1,model:'fixture-model',choices:[{index:0,delta:{},finish_reason:'stop'}]}
  ]:[
   {id:'completion-1',object:'chat.completion.chunk',created:1,model:'fixture-model',choices:[{index:0,delta:{role:'assistant',tool_calls:Array.from({length:toolCount},(_,index)=>({index,id:toolCount===1?'original-call':'batch-call-'+index,type:'function',function:{name:'originalCapability',arguments:JSON.stringify({goalId:toolCount===1?'goal-7':'goal-'+index})}}))},finish_reason:null}]},
   {id:'completion-1',object:'chat.completion.chunk',created:1,model:'fixture-model',choices:[{index:0,delta:{},finish_reason:'tool_calls'}]}
  ];
  return new Response(data.map(value=>'data: '+JSON.stringify(value)+'\n\n').join('')+'data: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});
 };
 return {restore(){globalThis.fetch=originalFetch;},get calls(){return calls;}};
}

test('real Mastra, local storage and official adapter run the injected function and stream its result offline',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'neon-agent-offline-'));const gateway=fixtureGateway();let executions=0;
 try {
  const runtime=await createLocalNeonAgentRuntime({config:{apiKey:'fixture-no-key',baseURL:'https://fixture.ai.neon.tech',model:'fixture-model'},dataDirectory:directory,resourceId:'local-owner',instructions:'Use originalCapability to perform the user goal.',tools:[{id:'originalCapability',description:'Fixture capability injection',inputSchema:z.object({goalId:z.string()}),requiresApproval:false,async execute(input,context){executions++;assert.equal(context.threadId,'actual-thread');return {original:true,input};}}]});
  const stream=await events(await runtime.handleRun(request('actual-run')));
  assert.equal(stream[0].type,'RUN_STARTED');
  const result=stream.find(e=>e.type==='TOOL_CALL_RESULT');assert.ok(result,JSON.stringify(stream));
  assert.deepEqual(JSON.parse(result.content),{original:true,input:{goalId:'goal-7'}});
  assert.equal(stream.at(-1).type,'RUN_FINISHED');assert.equal(executions,1);assert.equal(gateway.calls,2);
  await runtime.mastra.getStorage()?.close();
 } finally {gateway.restore();await rm(directory,{recursive:true,force:true});}
});

for(const approved of [true,false]) test('real persisted Mastra approval '+(approved?'executes once after exact resume':'declines without executing'),async()=>{
 const directory=await mkdtemp(join(tmpdir(),'neon-approval-offline-'));const gateway=fixtureGateway();let executions=0;
 const options={config:{apiKey:'fixture-no-key',baseURL:'https://fixture.ai.neon.tech',model:'fixture-model'},dataDirectory:directory,resourceId:'local-owner',instructions:'Call originalCapability.',tools:[{id:'originalCapability',description:'Approval guarded original capability',inputSchema:z.object({goalId:z.string()}),requiresApproval:true,async execute(){executions++;return {approvedResult:'actual capability result'};}}]};
 try {
  const first=await createLocalNeonAgentRuntime(options);
  const interrupted=await events(await first.handleRun(request('approval-run')));
  const end=interrupted.at(-1);assert.equal(end.type,'RUN_FINISHED',JSON.stringify(interrupted));assert.equal(end.outcome.type,'interrupt');assert.equal(executions,0);
  const interrupt=end.outcome.interrupts[0];assert.equal(interrupt.reason,'mastra:tool_approval');
  assert.deepEqual(interrupt.metadata.mastra.args,{goalId:'goal-7'});
  await first.mastra.getStorage()?.close();
  // Reconstruct every runtime object to prove file persistence across reload.
  const second=await createLocalNeonAgentRuntime(options);
  assert.equal((await second.pending('actual-thread'))[0].id,interrupt.id);
  const resumed=await events(await second.handleRun(request('resume-run',[{interruptId:interrupt.id,status:'resolved',payload:{approved}}])));
  assert.equal(resumed.at(-1).type,'RUN_FINISHED',JSON.stringify(resumed));assert.equal(executions,approved?1:0);
  assert.ok(resumed.some(e=>e.type==='TOOL_CALL_RESULT'));
  assert.equal((await second.handleRun(request('stale-run',[{interruptId:interrupt.id,status:'resolved',payload:{approved:true}}]))).status,409);
  await second.mastra.getStorage()?.close();
 } finally {gateway.restore();await rm(directory,{recursive:true,force:true});}
});

test('local file thread store persists and serializes independent writers',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'neon-thread-offline-'));const scope={resourceId:'owner',threadId:'thread'};
 try {
  const a=createFileThreadStateStore(directory);const b=createFileThreadStateStore(directory);
  await Promise.all(Array.from({length:8},(_,i)=>(i%2?a:b).update(scope,current=>({status:'idle',runIds:[...(current?.runIds??[]),String(i)],pending:[],state:{}}))));
  const state=await createFileThreadStateStore(directory).update(scope,current=>current!);
  assert.equal(new Set(state.runIds).size,8);
 } finally {await rm(directory,{recursive:true,force:true});}
});

test('Neon config requires a bare secure host and canonical token',()=>{
 assert.deepEqual(readNeonAgentConfig({NEON_AI_GATEWAY_TOKEN:'fixture',NEON_AI_GATEWAY_BASE_URL:'https://branch.ai.neon.tech',NEON_MODEL:'model'}),{apiKey:'fixture',baseURL:'https://branch.ai.neon.tech',model:'model'});
 assert.throws(()=>readNeonAgentConfig({NEON_AI_GATEWAY_TOKEN:'fixture',NEON_AI_GATEWAY_BASE_URL:'https://branch.ai.neon.tech/v1',NEON_MODEL:'model'}));
});

test('native two-tool turn exposes approvals sequentially and rejects the second without execution',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'neon-two-approvals-offline-'));const gateway=fixtureGateway(2);const executed:string[]=[];
 const options={config:{apiKey:'fixture-no-key',baseURL:'https://fixture.ai.neon.tech',model:'fixture-model'},dataDirectory:directory,resourceId:'local-owner',instructions:'Call the original capability as instructed.',tools:[{id:'originalCapability',description:'Guarded original capability',inputSchema:z.object({goalId:z.string()}),requiresApproval:true,async execute(input:unknown){const goal=(input as {goalId:string}).goalId;executed.push(goal);return {originalGoal:goal};}}]};
 try {
  const first=await createLocalNeonAgentRuntime(options);
  const interrupted=await events(await first.handleRun(request('two-tools-start')));
  const pending=interrupted.at(-1).outcome.interrupts;
  assert.equal(pending.length,1,JSON.stringify(interrupted));assert.deepEqual(executed,[]);
  await first.mastra.getStorage()?.close();
  const second=await createLocalNeonAgentRuntime(options);
  const snapshot=await second.snapshot('actual-thread');assert.equal(snapshot.pending.length,1);assert.ok(snapshot.messages.some(m=>m.role==='user'));
  const middle=await events(await second.handleRun(request('approve-first',[{interruptId:pending[0].id,status:'resolved',payload:{approved:true}}])));
  assert.deepEqual(executed,['goal-0']);
  const next=middle.at(-1).outcome.interrupts;
  assert.equal(next.length,1,JSON.stringify(middle));assert.equal(next[0].metadata.mastra.args.goalId,'goal-1');
  const completed=await events(await second.handleRun(request('decline-second',[{interruptId:next[0].id,status:'resolved',payload:{approved:false}}])));
  assert.equal(completed.filter(e=>e.type==='RUN_STARTED').length,1);
  assert.equal(completed.at(-1).type,'RUN_FINISHED',JSON.stringify(completed));
  assert.deepEqual(executed,['goal-0']);assert.equal((await second.pending('actual-thread')).length,0);
  const declined=completed.find(e=>e.type==='TOOL_CALL_RESULT' && e.toolCallId===next[0].toolCallId);assert.ok(declined,JSON.stringify(completed));assert.equal(JSON.parse(declined.content).approved,false,JSON.stringify(completed));
  assert.ok((await second.snapshot('actual-thread')).messages.some(m=>m.role==='tool'));
  await second.mastra.getStorage()?.close();
 } finally {gateway.restore();await rm(directory,{recursive:true,force:true});}
});

 test('Neon Luna sends exact reasoning_effort none on the native tool request wire',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'neon-luna-tools-'));const gateway=fixtureGateway(1,'gpt-5-6-luna');let executions=0;
 try {
  const runtime=await createLocalNeonAgentRuntime({config:{apiKey:'fixture-no-key',baseURL:'https://fixture.ai.neon.tech',model:'gpt-5-6-luna'},dataDirectory:directory,resourceId:'local-owner',instructions:'Use originalCapability.',tools:[{id:'originalCapability',description:'Local fixture',inputSchema:z.object({goalId:z.string()}),requiresApproval:false,async execute(){executions++;return {saved:true};}}]});
  try {const stream=await events(await runtime.handleRun(request('luna-tools')));assert.equal(stream.at(-1).type,'RUN_FINISHED',JSON.stringify(stream));assert.equal(executions,1);assert.equal(gateway.calls,2);}finally{await runtime.mastra.getStorage()?.close();}
 }finally{gateway.restore();await rm(directory,{recursive:true,force:true});}
});
