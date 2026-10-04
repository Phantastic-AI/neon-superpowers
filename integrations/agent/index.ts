import { Agent } from '@mastra/core/agent';
import { Mastra } from '@mastra/core/mastra';
import { createTool } from '@mastra/core/tools';
import type { MastraCompositeStore } from '@mastra/core/storage';
import { Memory } from '@mastra/memory';
import { LibSQLStore } from '@mastra/libsql';
import { MastraAgent } from '@ag-ui/mastra';
import { z } from 'zod';
import type { PublicSchema } from '@mastra/core/schema';
import { resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { createRunHandler, type ThreadStateStore } from './transport.ts';
import { createFileThreadStateStore } from './file-store.ts';
import { adaptMastraForAgUi } from './ag-ui-compat.ts';
export { createFileThreadStateStore, createRunHandler };
export type { ThreadStateStore, ThreadState, ThreadScope } from './transport.ts';

export interface CapabilityContext {signal:AbortSignal|undefined;threadId:string;resourceId:string;toolCallId:string}
export interface CapabilityTool {
 id: string;
 description: string;
 inputSchema: PublicSchema<unknown>;
 /** Every capability which can change an external application must set true. */
 requiresApproval: boolean;
 execute(input: unknown, context: CapabilityContext): Promise<unknown>;
}
export interface NeonAgentConfig {apiKey:string;baseURL:string;model:string}
export interface NeonAgentOptions {
 config:NeonAgentConfig;
 storage:MastraCompositeStore;
 threads:ThreadStateStore;
 tools:CapabilityTool[];
 resourceId:string;
 instructions:string;
}

export function readNeonAgentConfig(env:Record<string,string|undefined>):NeonAgentConfig {
 const apiKey=env.NEON_AI_GATEWAY_TOKEN??env.NEON_AI_GATEWAY_API_KEY;
 const baseURL=env.NEON_AI_GATEWAY_BASE_URL;
 const model=env.NEON_MODEL;
 if(!apiKey||!baseURL||!model)throw new Error('NEON_AI_GATEWAY_TOKEN, NEON_AI_GATEWAY_BASE_URL and NEON_MODEL are required');
 const url=new URL(baseURL);
 if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||url.pathname!=='/')throw new Error('Neon gateway URL must be a bare HTTPS branch host');
 return {apiKey,baseURL:url.origin,model};
}

export function createCapabilityTools(capabilities:CapabilityTool[]) {
 const tools:Record<string,ReturnType<typeof createTool>>={};
 for(const capability of capabilities) {
  if(!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(capability.id)||Object.hasOwn(tools,capability.id))throw new Error('Capability IDs must be unique valid tool names');
  tools[capability.id]=createTool({
   id:capability.id,description:capability.description,inputSchema:capability.inputSchema,
   outputSchema:z.unknown(),requireApproval:capability.requiresApproval,
   execute:async(input,context)=>{
    context?.abortSignal?.throwIfAborted();
    if(!context?.agent?.threadId||!context.agent.resourceId||!context.agent.toolCallId)throw new Error('Capability requires authenticated agent scope');
    return capability.execute(input,{signal:context.abortSignal,threadId:context.agent.threadId,resourceId:context.agent.resourceId,toolCallId:context.agent.toolCallId});
   }
  });
 }
 return tools;
}

/** Constructs an actual local Mastra agent. Does not make a model request. */
export function createNeonAgentRuntime(options:NeonAgentOptions) {
 const tools=createCapabilityTools(options.tools);
 const agent=new Agent({id:'neon-superpowers',name:'Superpowers',instructions:options.instructions,
  model:{providerId:'neon',modelId:options.config.model,url:options.config.baseURL.replace(/\/$/,'')+'/v1',apiKey:options.config.apiKey,api:'chat'},
  tools,memory:new Memory({storage:options.storage,options:{lastMessages:40}}),defaultOptions:{maxSteps:8}});
 const mastra=new Mastra({agents:{superpowers:agent},storage:options.storage});
 const handler=createRunHandler({resourceId:options.resourceId,threads:options.threads,createBridge:()=>new MastraAgent({agent:adaptMastraForAgUi(agent),resourceId:options.resourceId,emitInterruptOutcome:true,streamServerToolCalls:true})});
 return {...handler,agent,mastra};
}

/** Local single-sidecar composition. No database credentials or model calls. */
export async function createLocalNeonAgentRuntime(options:Omit<NeonAgentOptions,'storage'|'threads'> & {dataDirectory:string}) {
 const directory=resolve(options.dataDirectory);await mkdir(directory,{recursive:true,mode:0o700});
 const storage=new LibSQLStore({id:'neon-superpowers-local',url:'file:'+resolve(directory,'mastra.db')});
 return createNeonAgentRuntime({...options,storage,threads:createFileThreadStateStore(resolve(directory,'threads'))});
}
