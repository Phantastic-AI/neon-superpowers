import { execFileSync } from 'node:child_process';
import { describe, it, expect, vi } from 'vitest';
import { createRemoteTools, type Clients } from './index.js';
function fixture() {
 const exec = vi.fn(async (file: string, args: string[]) => ({stdout: execFileSync(file, args, {encoding:'utf8'}),exitCode:0}));
 const query = vi.fn(async () => []); const deleteByID = vi.fn(async () => undefined);
 const clients: Clients = { liveReady:true, approve:vi.fn(async()=>true), spriteName:'demo-guest',databaseScope:'demo-db',executorOrganization:'demo-org',allowedResearchHosts:['example.com'], kernel:{browsers:{create:vi.fn(async()=>({session_id:'synthetic-browser'})),deleteByID,playwright:{execute:vi.fn(async()=>({result:{title:'Synthetic event'}}))}}},sprites:{sprite:()=>({execFile:exec})},executor:{callTool:vi.fn(async()=>({content:[]}))},neon:{query} };
 return {clients,exec,query,deleteByID,tools:createRemoteTools(clients)};
}
describe('bounded sponsor capabilities',()=>{
 it('never touches transport before readiness or approval',async()=>{ const f=fixture();f.clients.liveReady=false;await expect(f.tools.normalizeCsv('name\nAda')).rejects.toThrow('disabled');expect(f.exec).not.toHaveBeenCalled();f.clients.liveReady=true;f.clients.approve=async()=>false;await expect(f.tools.normalizeCsv('name\nAda')).rejects.toThrow('declined');expect(f.exec).not.toHaveBeenCalled(); });
 it('normalizes through a guest computation and records attribution',async()=>{const f=fixture();const result=await f.tools.normalizeCsv('name\nAda\n ada ');expect(f.exec).toHaveBeenCalledOnce();expect(result.output.duplicatesRemoved).toBe(1);expect(result.sponsor).toBe('Sprites');expect(result.cost.status).toBe('unknown');});
 it('passes the Python program as one argv value without shell parsing',async()=>{const f=fixture();const result=await f.tools.normalizeCsv('name,note\n"Ada Lovelace","$HOME; $(echo nope)"');expect(f.exec).toHaveBeenCalledWith('python3',['-c',expect.any(String)],expect.anything());expect(result.output.rows[0].name).toBe('Ada Lovelace');expect(result.output.rows[0].note).toBe('$HOME; $(echo nope)');});
 it('prepares only the dedicated table behind approval',async()=>{const f=fixture();await f.tools.prepareSnapshotSharing();expect(f.clients.approve).toHaveBeenCalledWith(expect.objectContaining({sponsor:'Neon',resource:'demo-db',action:'Prepare selected event snapshot table'}));expect(f.query).toHaveBeenCalledWith(expect.stringContaining('CREATE TABLE IF NOT EXISTS neon_event_snapshots'),[],expect.anything());});
 it('shares only selected fields with parameterized SQL',async()=>{const f=fixture();await f.tools.shareEventSnapshot([{id:'synthetic-1',title:'Demo',startsAt:'2026-10-04',location:'Demo venue',sourceUrl:'https://example.com'}]);expect(f.query).toHaveBeenCalledOnce();});
 it('tears down research browser and rejects unrelated hosts',async()=>{const f=fixture();await f.tools.researchPage('https://example.com');expect(f.deleteByID).toHaveBeenCalledWith('synthetic-browser',expect.anything());expect(()=>f.tools.researchPage('https://internal.example')).toThrow('outside');});
 it('rejects unreviewed tool paths and executes exactly the reviewed selection',async()=>{const f=fixture();expect(()=>f.tools.executeResearchTool('tools.gmail.send',{})).toThrow('allowlist');f.clients.executorResearchTools=['tools.publicresearch.search'];await f.tools.executeResearchTool('tools.publicresearch.search',{query:'synthetic event'});expect(f.clients.executor!.callTool).toHaveBeenCalledWith({name:'execute',arguments:{code:'return await tools.publicresearch.search({"query":"synthetic event"});'}},expect.anything());});
 it('approves and dispatches one immutable argument snapshot across awaits',async()=>{
  const f=fixture();f.clients.executorResearchTools=['tools.publicresearch.search'];
  const args={query:'approved first',filters:{city:'Synthetic city'}};
  let finishApproval!: (allowed:boolean)=>void;
  let observed!: {path:string;args:typeof args};
  f.clients.approve=async request=>{
   observed=request.payload as typeof observed;
   expect(Object.isFrozen(observed)).toBe(true);expect(Object.isFrozen(observed.args.filters)).toBe(true);
   expect(()=>{observed.args.query='changed by approval';}).toThrow();
   return await new Promise<boolean>(resolve=>{finishApproval=resolve;});
  };
  const pending=f.tools.executeResearchTool('tools.publicresearch.search',args);
  args.query='changed by caller';args.filters.city='Other city';
  expect(observed.args).toEqual({query:'approved first',filters:{city:'Synthetic city'}});
  finishApproval(true);await pending;
  expect(f.clients.executor!.callTool).toHaveBeenCalledWith({name:'execute',arguments:{code:'return await tools.publicresearch.search({"query":"approved first","filters":{"city":"Synthetic city"}});'}},expect.anything());
 });
 it('keeps ready sponsors usable when another sponsor is missing',async()=>{const f=fixture();delete f.clients.neon;await f.tools.researchPage('https://example.com');await expect(f.tools.shareEventSnapshot([{id:'synthetic',title:'Demo',startsAt:'2026',location:'Demo',sourceUrl:'https://example.com'}])).rejects.toThrow('disabled');});
 it('calls Executor actual execute discovery rather than invented app tools',async()=>{const f=fixture();await f.tools.discoverResearchTools('public event research');expect(f.clients.executor!.callTool).toHaveBeenCalledWith({name:'execute',arguments:{code:'return await tools.search({query:"public event research"});'}},expect.anything());});
});
