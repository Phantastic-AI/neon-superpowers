import { AbstractAgent, defaultApplyEvents, transformChunks } from '@ag-ui/client';
import type { BaseEvent, Message, RunAgentInput } from '@ag-ui/core';
import { EMPTY, from } from 'rxjs';

class SnapshotAgent extends AbstractAgent { run() {return EMPTY;} }
/** Use the official AG-UI reducer for transcript and RFC-6902 state semantics. */
export async function reduceRunSnapshot(input:RunAgentInput, previous:Message[], events:BaseEvent[]) {
 const messages=[...previous];
 for(const message of input.messages)if(!messages.some(m=>m.id===message.id))messages.push(message);
 const projector=new SnapshotAgent({initialMessages:messages,initialState:input.state});
 const result={messages,state:input.state as Record<string,unknown>};
 await new Promise<void>((resolve,reject)=>{
  defaultApplyEvents(input,from(events).pipe(transformChunks()),projector,[]).subscribe({
   next(mutation){if(mutation.messages)result.messages=mutation.messages;if(mutation.state)result.state=mutation.state;},
   complete:resolve,error:reject,
  });
 });
 return result;
}
