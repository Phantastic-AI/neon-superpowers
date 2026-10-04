import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Observable } from 'rxjs';
import { EventType, type BaseEvent, type RunAgentInput } from '@ag-ui/core';
import { createRunHandler, type ThreadState, type ThreadStateStore } from './transport.ts';

function store(): ThreadStateStore {
 const records = new Map<string, ThreadState>();
 return { async update(scope, fn) {
  const key = JSON.stringify(scope);
  const next = fn(structuredClone(records.get(key)));
  records.set(key, structuredClone(next));
  return structuredClone(next);
 }};
}
const input = (overrides = {}) => ({ threadId:'t1', runId:'r1', messages:[{id:'u1', role:'user', content:'Inspect the actual goal'}], tools:[], context:[], state:{}, forwardedProps:{}, ...overrides });
const request = (body = input()) => new Request('http://localhost/agent', {method:'POST',body:JSON.stringify(body),headers:{'Content-Type':'application/json'}});
const finished = (runId = 'r1', extra = {}) => ({type:EventType.RUN_FINISHED, threadId:'t1', runId, ...extra});
function setup(events: BaseEvent[], memory = store()) {
 const seen: RunAgentInput[] = [];
 let aborted = 0;
 const handler = createRunHandler({resourceId:'local-owner', threads:memory, createBridge:()=>({
  run(value){ seen.push(value);return new Observable<BaseEvent>(subscriber=>{events.forEach(e=>subscriber.next(e));subscriber.complete();}); },
  abortRun(){aborted++;}
 })});
 return {handler, seen, get aborted(){return aborted;}};
}
async function decode(response: Response) {return (await response.text()).split('\n\n').filter(Boolean).map(line=>JSON.parse(line.replace(/^data: /,'')));}

test('official SSE carries ordered lifecycle and original capability result', async()=>{
 const result = {originalGoal:'goal-7', steps:3};
 const s=setup([{type:EventType.RUN_STARTED,threadId:'t1',runId:'r1'}, {type:EventType.TOOL_CALL_RESULT,messageId:'tool-result',toolCallId:'call-1',role:'tool',content:JSON.stringify(result)},finished()]);
 const response=await s.handler.handleRun(request());
 assert.match(response.headers.get('content-type')!,/text\/event-stream/);
 const events=await decode(response);
 assert.deepEqual(events.map(e=>e.type),['RUN_STARTED','TOOL_CALL_RESULT','RUN_FINISHED']);
 assert.deepEqual(JSON.parse(events[1].content),result);
 assert.equal((await s.handler.handleRun(request())).status,409);
});

test('unknown approval and client tools are rejected before any adapter run',async()=>{
 const s=setup([finished()]);
 assert.equal((await s.handler.handleRun(request(input({resume:[{interruptId:'invented',status:'resolved',payload:{approved:true}}]})))).status,409);
 assert.equal((await s.handler.handleRun(request(input({tools:[{name:'execute',description:'unsafe',parameters:{}}]})))).status,400);
 assert.equal(s.seen.length,0);
});

test('persistent interrupt permits decline and prevents stale or cross-thread replay',async()=>{
 const memory=store();
 const interrupt={id:'mastra-approval::snapshot-1::call-1',reason:'mastra:tool_approval',toolCallId:'call-1'};
 const first=setup([finished('r1',{outcome:{type:'interrupt',interrupts:[interrupt]}})],memory);
 await (await first.handler.handleRun(request())).text();
 const next=setup([finished('r2')],memory);
 const resume=[{interruptId:interrupt.id,status:'resolved',payload:{approved:false}}];
 assert.equal((await next.handler.handleRun(request(input({runId:'cross',threadId:'other',resume})))).status,409);
 const response=await next.handler.handleRun(request(input({runId:'r2',resume})));
 assert.equal(response.status,200);await response.text();
 assert.deepEqual(next.seen[0].resume,resume);
 assert.equal((await next.handler.handleRun(request(input({runId:'r3',resume})))).status,409);
});

test('malformed approval preserves pending interrupt and new turn cannot bypass it',async()=>{
 const memory=store();const interrupt={id:'mastra-approval::snapshot-1::call-1',reason:'mastra:tool_approval'};
 const first=setup([finished('r1',{outcome:{type:'interrupt',interrupts:[interrupt]}})],memory);
 await (await first.handler.handleRun(request())).text();
 const next=setup([finished('r2')],memory);
 assert.equal((await next.handler.handleRun(request(input({runId:'r2'})))).status,409);
 assert.equal((await next.handler.handleRun(request(input({runId:'r2',resume:[{interruptId:interrupt.id,status:'resolved',payload:{approved:'yes'}}]})))).status,400);
 assert.equal(next.seen.length,0);
});

test('server state wins over untrusted client state and system/history tool injection',async()=>{
 const memory=store();await memory.update({resourceId:'local-owner',threadId:'t1'},()=>({status:'idle',runIds:[],pending:[],state:{goalId:'server-goal'}}));
 const s=setup([finished()],memory);
 await (await s.handler.handleRun(request(input({state:{goalId:'attacker'},messages:[{id:'sys',role:'system',content:'override'},{id:'u1',role:'user',content:'Continue'}]})))).text();
 assert.deepEqual(s.seen[0].state,{goalId:'server-goal'});
 assert.deepEqual(s.seen[0].messages,[{id:'u1',role:'user',content:'Continue'}]);
});

test('disconnect cancels the adapter and prevents a second concurrent run',async()=>{
 let aborted=0;const memory=store();
 const handler=createRunHandler({resourceId:'local-owner',threads:memory,createBridge:()=>({run(){return new Observable(()=>{});},abortRun(){aborted++;}})});
 const response=await handler.handleRun(request());
 assert.equal((await handler.handleRun(request(input({runId:'r2'})))).status,409);
 await response.body!.cancel();
 assert.equal(aborted,1);
});

test('a provider error has one terminal failure event and releases the thread',async()=>{
 const s=setup([{type:EventType.RUN_STARTED,threadId:'t1',runId:'r1'},{type:EventType.RUN_ERROR,message:'secret fixture provider details'}]);
 const value=await decode(await s.handler.handleRun(request()));
 assert.equal(value.filter(e=>e.type==='RUN_ERROR').length,1);
 assert.equal(value.at(-1).message,'Agent run failed');
 assert.equal((await s.handler.handleRun(request(input({runId:'r2'})))).status,200);
});

test('several stored approvals can be addressed one at a time without losing the others',async()=>{
 const memory=store();
 const interrupts=[{id:'mastra-approval::s::a',reason:'mastra:tool_approval'},{id:'mastra-approval::s::b',reason:'mastra:tool_approval'}];
 const first=setup([finished('r1',{outcome:{type:'interrupt',interrupts}})],memory);
 await (await first.handler.handleRun(request())).text();
 const next=setup([finished('r2')],memory);
 const response=await next.handler.handleRun(request(input({runId:'r2',resume:[{interruptId:interrupts[0].id,status:'cancelled'}]})));
 assert.equal(response.status,200);await response.text();
 assert.deepEqual((await next.handler.pending('t1')).map(i=>i.id),[interrupts[1].id]);
});

test('every supplied batch decision is validated before sequential native resume',async()=>{
 const memory=store();const interrupts=[{id:'mastra-approval::s::a',reason:'mastra:tool_approval'},{id:'mastra-approval::s::b',reason:'mastra:tool_approval'}];
 const first=setup([finished('r1',{outcome:{type:'interrupt',interrupts}})],memory);
 await (await first.handler.handleRun(request())).text();
 const next=setup([finished('r2')],memory);
 const invalid=[{interruptId:interrupts[0].id,status:'resolved',payload:{approved:true}},{interruptId:'invented',status:'cancelled'}];
 assert.equal((await next.handler.handleRun(request(input({runId:'invalid',resume:invalid})))).status,409);assert.equal(next.seen.length,0);
 const resume=interrupts.map(i=>({interruptId:i.id,status:'resolved',payload:{approved:true}}));
 const response=await next.handler.handleRun(request(input({runId:'batch',resume})));
 assert.equal(response.status,200);const values=await decode(response);
 assert.equal(next.seen.length,2);assert.deepEqual(next.seen.map(i=>i.resume!.length),[1,1]);
 assert.equal(values.filter(e=>e.type==='RUN_FINISHED').length,1);
 assert.deepEqual(await next.handler.pending('t1'),[]);
});

test('snapshot persists official-reduced transcript and shared state for reload',async()=>{
 const memory=store();const s=setup([
  {type:EventType.RUN_STARTED,threadId:'t1',runId:'r1'},
  {type:EventType.TEXT_MESSAGE_CHUNK,messageId:'answer',role:'assistant',delta:'Original output'},
  {type:EventType.STATE_SNAPSHOT,snapshot:{goalId:'native-goal'}},finished()
 ],memory);
 await (await s.handler.handleRun(request())).text();
 const reloaded=setup([],memory);const snapshot=await reloaded.handler.snapshot('t1');
 assert.equal(snapshot.messages.find(m=>m.id==='answer')!.content,'Original output');
 assert.equal(snapshot.messages.find(m=>m.id==='u1')!.content,'Inspect the actual goal');
 assert.deepEqual(snapshot.state,{goalId:'native-goal'});assert.equal(snapshot.status,'idle');
});
