import { EventEncoder } from '@ag-ui/encoder';
import { EventType, type BaseEvent, type Interrupt, type Message, type RunAgentInput } from '@ag-ui/core';
import { RunAgentInputSchema } from '@ag-ui/core/schemas';
import type { Observable } from 'rxjs';
import { reduceRunSnapshot } from './snapshot.ts';
import { createBatchBridge } from './batch.ts';

export interface ThreadScope { resourceId: string; threadId: string }
export interface ThreadState {
 status: 'idle' | 'running';
 runIds: string[];
 pending: Interrupt[];
 state: Record<string, unknown>;
 messages?: Message[];
}
/** Must atomically read-transform-persist within the exact resource/thread scope. */
export interface ThreadStateStore {
 update(scope: ThreadScope, transform: (current: ThreadState | undefined) => ThreadState): Promise<ThreadState>;
}
export interface AgentBridge { run(input: RunAgentInput): Observable<BaseEvent>; abortRun(): void }
export interface RunHandlerOptions {
 resourceId: string;
 threads: ThreadStateStore;
 createBridge(): AgentBridge;
}
class RequestFailure extends Error { constructor(readonly status: number, message: string) { super(message); } }
const empty = (): ThreadState => ({ status:'idle', runIds:[], pending:[], state:{} });

function claim(current: ThreadState | undefined, input: RunAgentInput): ThreadState {
 const record = current ?? empty();
 if(record.status === 'running') throw new RequestFailure(409,'Thread already has an active run');
 if(record.runIds.includes(input.runId)) throw new RequestFailure(409,'Run ID was already used');
 const resume = input.resume ?? [];
 if(record.pending.length) {
  if(!resume.length || new Set(resume.map(r=>r.interruptId)).size!==resume.length || resume.some(r=>!record.pending.some(p=>p.id===r.interruptId)))
   throw new RequestFailure(409,'Resume must address known pending interrupts exactly once');
  for(const entry of resume) {
   const pending=record.pending.find(p=>p.id===entry.interruptId)!;
   if(pending.reason==='mastra:tool_approval' && entry.status==='resolved') {
    const payload=entry.payload;
    if(payload!==true && (!payload || typeof payload!=='object' || typeof (payload as {approved?:unknown}).approved!=='boolean'))
     throw new RequestFailure(400,'Approval answer must contain a boolean approved value');
   }
  }
 } else if(resume.length) throw new RequestFailure(409,'Interrupt is unknown or already settled');
 return {...record, status:'running', runIds:[...record.runIds, input.runId]};
}

/** Fetch handler for an authenticated local sidecar route. Authenticate before calling. */
export function createRunHandler(options: RunHandlerOptions) {
 const active = new Map<string, () => void>();
 const keyOf = (scope: ThreadScope) => JSON.stringify(scope);
 return {
  cancel(threadId: string) { const cancel = active.get(keyOf({resourceId:options.resourceId,threadId})); if(!cancel)return false;cancel();return true; },
  async snapshot(threadId:string) {let record=empty();await options.threads.update({resourceId:options.resourceId,threadId},current=>{record=current??empty();return record;});return {...record,messages:record.messages??[]};},
  async pending(threadId: string) { let pending: Interrupt[]=[];await options.threads.update({resourceId:options.resourceId,threadId},current=>{const record=current??empty();pending=record.pending;return record;});return pending; },
  async handleRun(request: Request): Promise<Response> {
   if(request.method !== 'POST') return Response.json({error:'POST required'},{status:405});
   if(request.signal.aborted) return Response.json({error:'Request cancelled'},{status:499});
   let input: RunAgentInput;
   let saved: ThreadState;
   let scope: ThreadScope;
   try {
    let body: unknown;
    try {body=await request.json();}catch {throw new RequestFailure(400,'Invalid JSON input');}
    const parsed = RunAgentInputSchema.safeParse(body);
    if(!parsed.success) throw new RequestFailure(400,'Invalid AG-UI run input');
    input = parsed.data;
    if(input.tools.length) throw new RequestFailure(400,'Client executable tools are disabled');
    if(input.forwardedProps && Object.keys(input.forwardedProps).length) throw new RequestFailure(400,'Forwarded commands are disabled; use standard resume');
    scope = {resourceId:options.resourceId,threadId:input.threadId};
    saved = await options.threads.update(scope,current=>claim(current,input));
   } catch(error) {
    return Response.json({error:error instanceof RequestFailure ? error.message : 'Unable to load agent thread'},{status:error instanceof RequestFailure ? error.status : 500});
   }
   // Mastra memory supplies authoritative assistant/tool history. Only user rows
   // from the caller are forwarded, preventing forged system/tool messages.
   input = {...input, state:saved.state, messages:input.messages.filter(m=>m.role==='user'), context:[], forwardedProps:{}, tools:[]};
   const encoder = new EventEncoder({accept:'text/event-stream'});
   const bytes = new TextEncoder();
   let bridge: AgentBridge;
   try {bridge=(input.resume?.length??0)>1?createBatchBridge(options.createBridge,saved.pending):options.createBridge();} catch {
    await options.threads.update(scope,current=>({...current!,status:'idle'}));
    return Response.json({error:'Unable to initialize agent'},{status:500});
   }
   let cancelled=false;
   let settled=false;
   let sawFinished=false;
   let sawError=false;
   const unaddressed=saved.pending.filter(p=>!input.resume?.some(r=>r.interruptId===p.id));
   let pending=saved.pending;
   let state=saved.state;
   let messages=saved.messages??[];
   const runEvents:BaseEvent[]=[];
   let reduced=false;
   const reduce=async()=>{if(reduced)return;const snapshot=await reduceRunSnapshot(input,saved.messages??[],runEvents);messages=snapshot.messages;state=snapshot.state;reduced=true;};
   let queue: Promise<void>=Promise.resolve();
   let stopSubscription: (()=>void)|undefined;
   let closeStream: (()=>void)|undefined;
   const release = async() => {
    if(settled)return;settled=true;
    active.delete(keyOf(scope));request.signal.removeEventListener('abort',cancel);
    await reduce();
    await options.threads.update(scope,current=>({...current!,status:'idle',state,pending,messages}));
   };
   const cancel = () => {
    if(cancelled || settled)return;cancelled=true;
    bridge.abortRun();stopSubscription?.();
    queue=queue.then(release).finally(()=>closeStream?.());
   };
   const stream = new ReadableStream<Uint8Array>({
    start(controller) {
     closeStream=()=>{try{controller.close();}catch{/* already disconnected */}};
     active.set(keyOf(scope),cancel);
     request.signal.addEventListener('abort',cancel,{once:true});
     if(request.signal.aborted){cancel();return;}
     const send = (event: BaseEvent) => {
      if(cancelled||sawFinished||sawError)return;
      const value=event as BaseEvent & {snapshot?:Record<string,unknown>;outcome?:{type:string;interrupts?:Interrupt[]}};
      if(event.type===EventType.STATE_SNAPSHOT && value.snapshot) state=value.snapshot;
      if(event.type===EventType.RUN_FINISHED) {
       sawFinished=true;
       const emitted=value.outcome?.type==='interrupt'?value.outcome.interrupts??[]:[];
       pending=[...new Map([...unaddressed,...emitted].map(item=>[item.id,item])).values()];
      }
      if(event.type===EventType.RUN_ERROR)sawError=true;
      const safe=event.type===EventType.RUN_ERROR?{type:EventType.RUN_ERROR,message:'Agent run failed'}:event;
      runEvents.push(safe);
      queue=queue.then(async()=>{
       if(cancelled)return;
       // Persist an approval before the UI can display its continuation token.
       if(event.type===EventType.RUN_FINISHED) {await reduce();await options.threads.update(scope,current=>({...current!,state,pending,messages}));}
       controller.enqueue(bytes.encode(encoder.encode(safe)));
      });
     };
     const finish=()=>{queue=queue.then(async()=>{
      if(!cancelled && !sawFinished && !sawError)controller.enqueue(bytes.encode(encoder.encode({type:EventType.RUN_ERROR,message:'Agent stream ended before completion'})));
      await release();closeStream?.();
     }).catch(async()=>{bridge.abortRun();await release();try{controller.error(new Error('Agent stream failed'));}catch{/* disconnected */}});};
     try {
      const subscription=bridge.run(input).subscribe({next:send,error:()=>finish(),complete:finish});
      stopSubscription=()=>subscription.unsubscribe();
     } catch {finish();}
    },
    async cancel() {cancel();await queue;}
   });
   return new Response(stream,{headers:{'Content-Type':encoder.getContentType(),'Cache-Control':'no-store','X-Accel-Buffering':'no'}});
  }
 };
}
