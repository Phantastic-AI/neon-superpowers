import type { Agent } from '@mastra/core/agent';
import type { ChunkType } from '@mastra/core/stream';

/** @mastra/core 1.74 adds denial/resume chunks not consumed by
 * @ag-ui/mastra 1.1.6. Normalize only the stream seen by the official adapter;
 * native snapshots, approval decisions and tool execution remain Mastra-owned.
 * Remove when the adapter recognizes tool-output-denied (covered offline).
 */
export function adaptMastraForAgUi(agent: Agent): Agent {
 const streamingMethods=new Set(['stream','resumeStream','approveToolCall','declineToolCall']);
 return new Proxy(agent,{get(target,key) {
  const value=Reflect.get(target,key,target);
  if(typeof value!=='function')return value;
  if(!streamingMethods.has(String(key)))return value.bind(target);
  return async(...args:unknown[])=>{
   const output=await value.apply(target,args);
   const fullStream=(output.fullStream as ReadableStream<ChunkType>).pipeThrough(new TransformStream<ChunkType,ChunkType>({
    transform(chunk,controller) {
     if(chunk.type==='tool-call-resumed')return;
     if(chunk.type==='tool-output-denied') {
      controller.enqueue({...chunk,type:'tool-result',payload:{...chunk.payload,result:{approved:false,...(chunk.payload.approval.reason?{reason:chunk.payload.approval.reason}:{})}}});
     } else controller.enqueue(chunk);
    }
   }));
   return new Proxy(output,{get(result,property) {
    if(property==='fullStream')return fullStream;
    const item=Reflect.get(result,property,result);return typeof item==='function'?item.bind(result):item;
   }});
  };
 }});
}
