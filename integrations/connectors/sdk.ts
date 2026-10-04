/** Server-only factories. Construction never starts OAuth, creates inboxes, or sends. */
import { createHash } from 'node:crypto';
import { createConnectors, ConnectorError } from './index.ts';
import type { ApprovedExecutor, ComposioPort, AgentMailPort, ConnectorOptions } from './index.ts';
export interface ConnectorEnvironment {
 COMPOSIO_API_KEY?: string; AGENTMAIL_API_KEY?: string;
 COMPOSIO_GMAIL_AUTH_CONFIG_ID?: string; COMPOSIO_CALENDAR_AUTH_CONFIG_ID?: string;
 COMPOSIO_GMAIL_CONNECTED_ACCOUNT_ID?: string; COMPOSIO_GOOGLECALENDAR_CONNECTED_ACCOUNT_ID?: string;
 AGENTMAIL_INBOX_ID?: string;
}
export interface SdkFactoryOptions { userId: string; approval?: ApprovedExecutor; env?: ConnectorEnvironment }
/** Lazy imports let the unconfigured application start without fetching provider schemas. */
export async function createSdkConnectors(input:SdkFactoryOptions) {
 if(typeof window!=='undefined') throw new ConnectorError('not_configured');
 const env=input.env ?? process.env;
 let composio:ComposioPort|undefined; let agentmail:AgentMailPort|undefined;
 if(env.COMPOSIO_API_KEY) {
  const { Composio }=await import('@composio/core');
  // Explicit key prevents SDK discovery of unrelated local CLI credentials.
  const client=new Composio({apiKey:env.COMPOSIO_API_KEY,allowTracking:false,disableVersionCheck:true});
  composio={
   listAccounts:query=>client.connectedAccounts.list(query,{signal:AbortSignal.timeout(15000)}),
   authorize:async(userId,toolkit,options)=>{
    const session=await client.create(userId,{toolkits:[toolkit],manageConnections:false,sandbox:{enable:false},...(options.authConfigId ? {authConfigs:{[toolkit]:options.authConfigId}} : {})},{signal:AbortSignal.timeout(15000)});
    const connection=await session.authorize(toolkit,{callbackUrl:options.callbackUrl});
    return {id:connection.id,redirectUrl:connection.redirectUrl};
   },
   // proxyExecute disables retries for non-idempotent writes in the pinned SDK.
   proxy:request=>client.tools.proxyExecute(request,{signal:AbortSignal.timeout(15000)}),
  };
 }
 if(env.AGENTMAIL_API_KEY) {
  const { AgentMailClient }=await import('agentmail');
  const client=new AgentMailClient({apiKey:env.AGENTMAIL_API_KEY,maxRetries:0,timeoutInSeconds:15});
  agentmail={
   getInbox:id=>client.inboxes.get(id),
   listMessages:(id,options)=>client.inboxes.messages.list(id,options),
   getMessage:(id,messageId)=>client.inboxes.messages.get(id,messageId),
   sendMessage:(id,payload)=>client.inboxes.messages.send(id,payload,{maxRetries:0}),
   createInbox:request=>client.inboxes.create(request,{maxRetries:0}),
  };
 }
 const options:ConnectorOptions={
  userId:input.userId,approval:input.approval,composio,agentmail,
  gmailAuthConfigId:env.COMPOSIO_GMAIL_AUTH_CONFIG_ID,calendarAuthConfigId:env.COMPOSIO_CALENDAR_AUTH_CONFIG_ID,
  gmailConnectedAccountId:env.COMPOSIO_GMAIL_CONNECTED_ACCOUNT_ID,calendarConnectedAccountId:env.COMPOSIO_GOOGLECALENDAR_CONNECTED_ACCOUNT_ID,
  agentMailInboxId:env.AGENTMAIL_INBOX_ID,
  agentMailProvisioningAccountId:env.AGENTMAIL_API_KEY ? `agentmail-key:${createHash('sha256').update(env.AGENTMAIL_API_KEY).digest('hex')}` : undefined,
 };
 return createConnectors(options);
}
