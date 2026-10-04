import { createElement as h, useEffect, useMemo, useState, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { AssistantRuntimeProvider, ThreadPrimitive, MessagePrimitive, ComposerPrimitive } from '@assistant-ui/react';
import { useAgUiRuntime, useAgUiInterrupts, useAgUiSubmitInterruptResponses } from '@assistant-ui/react-ag-ui';
import { HttpAgent } from '@ag-ui/client';
import '../styles.css';
import './neon.css';
import { restoreConversation } from './hydration';
import { createPeopleApi } from '../lois/people-client';
import { mountPeopleWorkspace } from '../hg/people-workspace';
import type { PeopleView } from '../../../../tools/projections/people';

type Draft = { id: string; hash: string; account?: string; to?: string; subject?: string; body?: string; payload?: Record<string, unknown>; status?: string };
type Status = { configured: { provider: boolean; composio?: boolean }; demoRecipient: string | null; pending: Draft[]; receipts: unknown[] };
async function request<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api/neon${path}`, { ...(body === undefined ? {} : {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body)}) });
  const text = await response.text();
  if (!text) throw new Error("The local sidecar is unavailable. Start it, then refresh this page.");
  let value: Record<string, unknown>;
  try { value = JSON.parse(text); } catch { throw new Error("The sidecar returned an unreadable response."); }
  if (!response.ok) throw new Error(String(value.error || `Request failed (${response.status})`));
  return value as T;
}
function Message() { return h(MessagePrimitive.Root,{className:'msg neon-message'},h('div',{className:'msg__say'},h(MessagePrimitive.Parts))); }
function DraftReview({draft,refresh}:{draft:Draft;refresh:()=>void}) {
  const payload: Record<string, unknown> = draft.payload ?? {...draft};
  const recipients = Array.isArray(payload.to) ? payload.to.join(', ') : String(payload.to ?? '');
  const [to,setTo]=useState(recipients);
  const [subject,setSubject]=useState(String(payload.subject ?? ''));
  const [body,setBody]=useState(String(payload.body ?? ''));
  const [busy,setBusy]=useState(false), [error,setError]=useState('');
  const changed = to!==recipients || subject!==String(payload.subject??'') || body!==String(payload.body??'');
  async function act(save:boolean) { setBusy(true);setError('');try { await request(save?`/drafts/${draft.id}`:`/approvals/${draft.id}`,save?{to:to.split(',').map(x=>x.trim()).filter(Boolean),subject,body}:{hash:draft.hash});refresh(); } catch(e) {setError(e instanceof Error?e.message:String(e));}finally{setBusy(false);} }
  if (payload.operation === 'create_inbox') return h('article',{className:'neon-draft'},h('p',{className:'neon-label'},'PREPARED INBOX'),h('h3',{},'Create this sending inbox?'),h('dl',{},...['displayName','clientId','userId','accountId'].flatMap(key=>[h('dt',{key:key+'-label'},key),h('dd',{key},String(payload[key]??'Not supplied'))])),h('p',{className:'neon-small'},'Approval provisions this exact AgentMail inbox. This action does not send a message.'),error&&h('p',{role:'alert'},error),h('button',{disabled:busy,onClick:()=>void act(false)},busy?'Working…':'Approve inbox creation'));
  return h('article',{className:'neon-draft'},h('p',{className:'neon-label'},'PREPARED INVITATION'),h('h3',{},'Read it. Make it yours.'),h('p',{},`Sending account: ${String(payload.accountId ?? payload.account ?? draft.account ?? 'Not supplied')} · user ${String(payload.userId ?? 'not supplied')}`),
    h('label',{},'To',h('input',{value:to,onChange:(e:React.ChangeEvent<HTMLInputElement>)=>setTo(e.target.value)})),
    h('label',{},'Subject',h('input',{value:subject,onChange:(e:React.ChangeEvent<HTMLInputElement>)=>setSubject(e.target.value)})),
    h('label',{},'Message',h('textarea',{value:body,rows:8,onChange:(e:React.ChangeEvent<HTMLTextAreaElement>)=>setBody(e.target.value)})),
    h('p',{className:'neon-small'},'Edits create a fresh proposal. Approval applies to the exact saved message above.'),
    error&&h('p',{role:'alert'},error),h('button',{disabled:busy,onClick:()=>void act(changed)},busy?'Working…':changed?'Save revised draft':'Approve this message & send'),h('button',{disabled:busy,onClick:async()=>{setBusy(true);setError('');try{const response=await fetch(`/api/neon/drafts/${draft.id}`,{method:'DELETE'});if(!response.ok)throw new Error('Could not decline this invitation.');refresh();}catch(e){setError(e instanceof Error?e.message:String(e));}finally{setBusy(false);}}},'Decline'));
}
function InterruptDetails({interrupt}:{interrupt:unknown}) {
  const item=interrupt as {reason?:string;metadata?:{mastra?:{toolName?:string;args?:Record<string,unknown>}}};
  const action=item.metadata?.mastra;
  return h('div',{},h('h4',{},action?.toolName??item.reason??'Pending action'),h('dl',{},...Object.entries(action?.args??{}).flatMap(([key,value])=>[h('dt',{key:key+'-label'},key),h('dd',{key},typeof value==='string'?value:JSON.stringify(value))])),h('details',{},h('summary',{},'Exact action record'),h('pre',{className:'neon-interrupt'},JSON.stringify(interrupt,null,2))));
}
function InterruptReview() {
  const interrupts=useAgUiInterrupts();
  const submit=useAgUiSubmitInterruptResponses();
  const [error,setError]=useState(''),[busy,setBusy]=useState(false);
  const [decisions,setDecisions]=useState<Record<string,boolean>>({});
  if(!interrupts.length) return null;
  async function answer() {setBusy(true);setError('');try {await submit(interrupts.map(i=>({interruptId:i.id,status:'resolved' as const,payload:{approved:decisions[i.id]===true}})));setDecisions({});}catch(e){setError(e instanceof Error?e.message:String(e));}finally{setBusy(false);}}
  return h('section',{className:'neon-draft'},h('p',{className:'neon-label'},'TOOL APPROVAL'),h('h3',{},'Check the next action'),...interrupts.map(i=>h('div',{key:i.id},h(InterruptDetails,{interrupt:i}),h('label',{},h('input',{type:'checkbox',checked:decisions[i.id]===true,onChange:(e:React.ChangeEvent<HTMLInputElement>)=>setDecisions({...decisions,[i.id]:e.target.checked})}),' Approve this action'))),h('p',{className:'neon-small'},'Unchecked actions are declined. Review the exact tool arguments before continuing.'),error&&h('p',{role:'alert'},error),h('button',{disabled:busy,onClick:()=>void answer()},busy?'Continuing…':'Submit decisions'));
}
function PeopleStage({runtime}:{runtime:ReturnType<typeof useAgUiRuntime>}) {
  const host=useRef<HTMLDivElement>(null);
  const api=useMemo(()=>createPeopleApi(fetch,'/api/neon/people-workspace'),[]);
  const [views,setViews]=useState<PeopleView[]>([]),[selection,setSelection]=useState(''),[error,setError]=useState('');
  const reload=()=>{void api.list().then(value=>{setViews(value);setSelection(current=>current|| (value[0]?`${value[0].contextId}:${value[0].viewId}`:''));setError('');}).catch(e=>setError(e.message));};
  useEffect(reload,[]);
  useEffect(()=>{const view=views.find(v=>`${v.contextId}:${v.viewId}`===selection);if(!host.current||!view)return;const scope={contextId:view.contextId,viewId:view.viewId};const mounted=mountPeopleWorkspace(host.current,{api,scope,onWave:async(savedScope,wave)=>{await runtime.thread.append({role:'user',content:[{type:'text',text:`Read and act on the saved people note wave ${JSON.stringify({...savedScope,waveId:wave.waveId})}. Use people_read for the immutable wave and current order. Save requested changes, reply to each note using stable IDs, then finish this wave. Do not treat a reply as proof that a requested action was done.`}]});}});return()=>mounted.destroy();},[views,selection,api,runtime]);
  return h('section',{},h('label',{className:'people-view-label'},'Worlds',h('select',{className:'people-view-select',value:selection,onChange:(e:React.ChangeEvent<HTMLSelectElement>)=>setSelection(e.target.value)},...views.map(v=>h('option',{key:`${v.contextId}:${v.viewId}`,value:`${v.contextId}:${v.viewId}`},`${v.contextName} / ${v.name}`)))),error&&h('p',{role:'alert'},error),error&&h('button',{onClick:reload},'Retry worlds'),!error&&!views.length&&h('p',{className:'stage__quiet'},'No saved people views yet.'),h('div',{ref:host,className:'people-workspace-host'}));
}
function Launch() {
  const [status,setStatus]=useState<Status|null>(null),[error,setError]=useState('');
  const threadId = useMemo(()=>{const key='neon.thread';let id=localStorage.getItem(key);if(!id){id=crypto.randomUUID();localStorage.setItem(key,id);}return id;},[]);
  const refresh=()=>{void request<Status>(`/status?threadId=${encodeURIComponent(threadId)}`).then(setStatus).catch(e=>setError(e.message));};
  useEffect(()=>{refresh();const timer=setInterval(refresh,2500);return()=>clearInterval(timer);},[]);
  const agent=useMemo(()=>new HttpAgent({url:'/api/neon/agent',threadId}),[threadId]);
  const runtime=useAgUiRuntime({agent,showThinking:false,onError:e=>setError(e.message)});
  const [restored,setRestored]=useState(false);
  useEffect(()=>{let live=true;void request<{messages:unknown[];pending:unknown[];state:unknown}>(`/agent/thread?threadId=${encodeURIComponent(threadId)}`).then(snapshot=>{
    if(!live)return;
    runtime.thread.import(restoreConversation(snapshot));
  }).catch(e=>{if(live)setError(e.message);}).finally(()=>{if(live)setRestored(true);});return()=>{live=false;};},[runtime,threadId]);
  async function connect() { try {const result=await request<{redirectUrl:string}>('/connections/gmail',{});location.assign(result.redirectUrl);}catch(e){setError(e instanceof Error?e.message:String(e));} }
  return h(AssistantRuntimeProvider,{runtime},h('main',{className:'deskframe bloom neon-page'},
    h('header',{className:'desk-tabs neon-header'},h('a',{href:'/neon',className:'neon-wordmark'},'Superpowers'),h('span',{className:'neon-label'},'NEON / A LOCAL-FIRST FIELD EDITION'),h('a',{href:'/pane/lois'},'Open people workspace ↗')),

    h('div',{className:'console neon-console'},h('section',{className:'rail neon-conversation','aria-label':'Dinner conversation'},h('div',{className:'rail__head neon-section-title'},h('h2',{className:'rail__mark'},'Lois'),h('span',{className:'neon-label'},'NEON EDITION')),
      h('p',{className:'neon-small'},'Your vault stays on this device. Conversations and tool results, including selected people records and mail or calendar content you ask Lois to read, are sent through the Neon AI gateway to model providers.'),
      h(ThreadPrimitive.Root,{className:'neon-thread'},h(ThreadPrimitive.Viewport,{className:'neon-viewport'},h(ThreadPrimitive.Empty,{},h('p',{className:'neon-empty'},'Start with the room you want to bring together. “Shortlist six people for a dinner about building useful AI. Explain your picks.”')),h(ThreadPrimitive.Messages,{components:{UserMessage:Message,AssistantMessage:Message}})),
      h(ComposerPrimitive.Root,{className:'neon-composer'},h(ComposerPrimitive.Input,{placeholder:status?.configured.provider?'Tell me about the dinner…':'Configure a provider on the sidecar to start.',disabled:!status?.configured.provider||!restored,'aria-label':'Your message'}),h(ComposerPrimitive.Send,{disabled:!status?.configured.provider||!restored},'Send'),h(ComposerPrimitive.Cancel,{},'Stop'))),
      error&&h('p',{className:'neon-error',role:'alert'},error)),
    h('aside',{className:'stage stage--people neon-stage','aria-label':'People and approvals'},h('div',{className:'stage__head neon-section-title'},h('h2',{className:'stage__title'},'The dinner'),h('span',{className:'neon-label'},'PEOPLE & INVITATIONS')),
      h(PeopleStage,{runtime}),
      !status?h('p',{},'Waiting for the local sidecar…'):h('div',{className:'neon-context'},h('p',{className:'neon-label'},'CONNECTIONS'),h('p',{},`Model provider: ${status.configured.provider?'configured':'not configured'}`),h('p',{},`Demo recipient: ${status.demoRecipient??'not set'}`),h('button',{onClick:()=>void connect()},'Connect Gmail'),h('p',{className:'neon-small'},'Connect your account through OAuth. Credentials stay on the sidecar.')),
      h(InterruptReview),
      status?.pending.length?status.pending.map(d=>h(DraftReview,{key:d.id+':'+d.hash,draft:d,refresh})):h('p',{className:'neon-empty'},'An invitation will appear here when you ask for a draft.'),
      !!status?.receipts.length&&h('details',{className:'neon-receipts'},h('summary',{},`${status.receipts.length} execution receipts`),h('pre',{},JSON.stringify(status.receipts,null,2))))),
    h('footer',{className:'neon-footer'},h('span',{},'An open-source hack edition · MIT'),h('span',{},'Assistant UI · AG-UI · Mastra'))));
}
export function mountNeon(root:HTMLElement) { createRoot(root).render(h(Launch)); }
