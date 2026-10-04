import { EventType, type BaseEvent, type Interrupt } from '@ag-ui/core';
import { concatMap, filter, from, map, tap } from 'rxjs';
import type { AgentBridge } from './transport.ts';

/** The official frontend answers all current interrupts together; the official
 * Mastra adapter accepts one per run. Sequence only explicit, prevalidated
 * decisions, keeping one HTTP lifecycle and every remaining/new interrupt.
 */
export function createBatchBridge(factory:()=>AgentBridge,pending:Interrupt[]):AgentBridge {
 let active:AgentBridge|undefined;
 return {
  abortRun(){active?.abortRun();},
  run(input) {
   const entries=input.resume!;const remaining=new Map(pending.map(i=>[i.id,i]));
   return from(entries).pipe(concatMap((entry,index)=>{
    active=factory();
    return active.run({...input,resume:[entry]}).pipe(
     tap(event=>{if(event.type===EventType.RUN_FINISHED){remaining.delete(entry.interruptId);const outcome=(event as BaseEvent & {outcome?:{type:string;interrupts?:Interrupt[]}}).outcome;if(outcome?.type==='interrupt')for(const i of outcome.interrupts??[])remaining.set(i.id,i);}}),
     filter(event=>!(event.type===EventType.RUN_STARTED && index>0)&&!(event.type===EventType.RUN_FINISHED && index<entries.length-1)),
     map(event=>event.type===EventType.RUN_FINISHED && remaining.size?{...event,outcome:{type:'interrupt',interrupts:[...remaining.values()]}}:event),
    );
   }));
  }
 };
}
