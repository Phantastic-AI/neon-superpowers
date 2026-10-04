import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNeonCapabilities, localPeople } from './capabilities.ts';
import { ApprovalLedger } from './ledger.ts';
import { LaunchState } from './state.ts';
import { openVault, registerContext, registerPerson } from '../../packages/vault/store.js';
import { loadWorld } from '../../packages/vault/world.js';
import { selectPeopleSources } from '../../packages/organs/people.js';
import { projectPeopleView } from '../../tools/projections/people.js';
import type { EnrichmentResult } from '../../integrations/enrichment/contract.ts';
import type { World } from '../../tools/projections/types.js';
const roots:string[]=[];
afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
function fixture(){
 const directory=mkdtempSync(join(tmpdir(),'neon-capabilities-'));roots.push(directory);
 const vaultDirectory=join(directory,'vault'),vault=openVault(vaultDirectory);
 registerContext(vault,{id:'W',name:'World',kind:'social',anchor:'linkedin',created_at:'2026-10-04T00:00:00Z'});
 selectPeopleSources(vault,{contextId:'W',viewId:'people',viewName:'People',sources:[{platform:'fixture',accountId:'fixture',eventId:'fixture',name:'Fixture',date:'2026-10-04',url:'https://example.test/event',evidence:['fixture:source']}],discoveryComplete:true});
 const state=new LaunchState(directory),ledger=new ApprovalLedger(directory);
 const options={directory,vaultDirectory,world:()=>loadWorld(openVault(vaultDirectory)),ledger,state,env:{},ready:()=>true,connectors:async()=>{throw new Error('Unexpected connector call');}};
 const execute=(id:string,input:unknown)=>createNeonCapabilities(options).find(t=>t.id===id)!.execute(input,{threadId:'fixture',resourceId:'fixture',toolCallId:'fixture',signal:undefined});
 return {directory,vaultDirectory,vault,state,ledger,options,execute};
}
function result(status:'matched'|'ambiguous'='matched'):EnrichmentResult{return {status:'ok',identity_match:{status,verification:'linkedin_anchor',confidence:0.99,reason:'Exact observed profile anchor'},person:{full_name:'New Fixture Person',linkedin_url:'https://www.linkedin.com/in/fixture-person'} as EnrichmentResult['person'],field_evidence:[],field_quality:{},sources:[{url:'https://www.linkedin.com/in/fixture-person'}],unresolved_fields:[],meta:{exa_request_ids:['fixture-exa'],cost_dollars:0,cost_complete:true,cache_hit:false}};}
describe('Scoped Neon capabilities around existing vault organs',()=>{
 it('does not expose person names, anchors or facts belonging only to apps_never_read contexts',()=>{
  const world:World={contexts:[{id:'visible',name:'Visible',kind:'social',anchor:'email',created_at:'fixture'},{id:'hidden',name:'Hidden',kind:'system',anchor:'email',created_at:'fixture',apps_never_read:true}],gatherings:[],persons:[{id:'private',name:'Hidden Person',state:'active',merged:[],sighted_at:'fixture',anchors:[{kind:'linkedin',value:'https://linkedin.com/in/private',context:'hidden',verified:true}]},{id:'shared',name:'Visible Person',state:'active',merged:[],sighted_at:'fixture',anchors:[{kind:'email',value:'visible@example.test',context:'visible',verified:true},{kind:'linkedin',value:'https://linkedin.com/in/private-shared',context:'hidden',verified:true}]}],entries:[{id:'secret',cursor:0,context:'hidden',type:'fact',at:'fixture',actor:{kind:'app',ref:'fixture'},persons:['shared'],payload:{bio:'Private system-only fact'}}]};
  expect(localPeople(world)).toMatchObject([{id:'shared',name:'Visible Person',linkedinUrl:null,facts:[]}]);expect(JSON.stringify(localPeople(world))).not.toMatch(/Hidden Person|private-shared|Private system/);
  expect(localPeople(world,{contextId:'hidden'})).toEqual([]);
 });
 it('requires an explicit World for model reads across multiple readable contexts',async()=>{
  const f=fixture();registerContext(openVault(f.vaultDirectory),{id:'other',name:'Another World',kind:'social',anchor:'email',created_at:'2026-10-04T00:00:00Z'});
  await expect(f.execute('read_local_people',{})).rejects.toThrow('Choose the exact World');
  expect(await f.execute('read_local_people',{contextId:'W'})).toMatchObject({people:[]});
 });
 it('saves only a matched, cited Exa prospect into the original local people projection and preserves replay',async()=>{
  const f=fixture();const receipt=f.state.receipt('Exa','research_prospect',{contextId:'W',name:'New Fixture Person',linkedinUrl:'https://www.linkedin.com/in/fixture-person',result:result()});
  const command={contextId:'W',viewId:'people',receiptId:receipt.id,requestId:'save',rationale:'Observed profile is relevant to the user goal',sources:['https://www.linkedin.com/in/fixture-person']};
  await expect(f.execute('people_save_prospect',{...command,sources:['https://invented.example/fake']})).rejects.toThrow('not in the research receipt');
  expect(await f.execute('people_save_prospect',command)).toMatchObject({ok:true,people:1});
  const saved=projectPeopleView(loadWorld(openVault(f.vaultDirectory)),'W','people')!;expect(saved.people[0]).toMatchObject({name:'New Fixture Person',identity:'verified',prospects:[{reason:{text:command.rationale,epistemics:'inferred'}}]});
  const cursor=openVault(f.vaultDirectory).entries.length;expect(await f.execute('people_save_prospect',command)).toMatchObject({ok:true,people:1});expect(openVault(f.vaultDirectory).entries).toHaveLength(cursor);
 });
 it('withholds ambiguous or wrong-anchor enrichment instead of creating a person',async()=>{
  const f=fixture();for(const enrichment of [result('ambiguous'),{...result(),person:{...result().person,linkedin_url:'https://linkedin.com/in/wrong-person'}}]){
   const receipt=f.state.receipt('Exa','research_prospect',{contextId:'W',name:'Fixture',linkedinUrl:'https://www.linkedin.com/in/fixture-person',result:enrichment});
   await expect(f.execute('people_save_prospect',{contextId:'W',viewId:'people',receiptId:receipt.id,requestId:receipt.id,rationale:'Fixture judgment',sources:['https://www.linkedin.com/in/fixture-person']})).rejects.toThrow('exact anchored identity');
  }
  expect(projectPeopleView(loadWorld(openVault(f.vaultDirectory)),'W','people')!.people).toEqual([]);
 });
 it('records anchored new-prospect research receipts through an injected model-free enrichment routine',async()=>{
  const f=fixture();const options={...f.options,enrich:async(input:{name:string;linkedin_url:string;context:string})=>{expect(input.linkedin_url).toBe('https://www.linkedin.com/in/fixture-person');return result();}};
  const tool=createNeonCapabilities(options).find(t=>t.id==='research_prospect')!;expect(tool.requiresApproval).toBe(true);
  expect(await tool.execute({contextId:'W',payload:{name:'Fixture Person',linkedin_url:'https://www.linkedin.com/in/fixture-person',context:'Reviewed research context'}},{signal:undefined,threadId:'fixture',resourceId:'fixture',toolCallId:'fixture'})).toMatchObject({sponsor:'Exa',action:'research_prospect',result:{contextId:'W',result:{identity_match:{status:'matched'}}}});
  expect(f.state.read().receipts).toHaveLength(1);
 });
 it('binds the exact local-person research payload before approval and never substitutes a newer goal',async()=>{
  const f=fixture();registerPerson(openVault(f.vaultDirectory),{id:'local-person',name:'Fixture Person',state:'active',merged:[],sighted_at:'2026-10-04T00:00:00Z',anchors:[{kind:'linkedin',value:'https://linkedin.com/in/fixture-person/',context:'W',verified:true}]});
  const enrich=vi.fn(async(_input:{name:string;linkedin_url:string;context:string})=>result());
  const tools=createNeonCapabilities({...f.options,enrich});const execute=(id:string,input:unknown)=>tools.find(t=>t.id===id)!.execute(input,{signal:undefined,threadId:'fixture',resourceId:'fixture',toolCallId:'fixture'});
  f.state.setGoal('The goal reviewed before suspension');
  const prepared=await execute('prepare_person_research',{contextId:'W',personId:'local-person'}) as {contextId:string;personId:string;payload:{name:string;linkedin_url:string;context:string}};
  expect(prepared.payload).toEqual({name:'Fixture Person',linkedin_url:'https://www.linkedin.com/in/fixture-person',context:'The goal reviewed before suspension'});
  expect(tools.find(t=>t.id==='enrich_person')!.requiresApproval).toBe(true);
  f.state.setGoal('A different goal added while approval was suspended');
  await execute('enrich_person',prepared);
  expect(enrich).toHaveBeenCalledExactlyOnceWith(prepared.payload,undefined);
 });
 it('fails closed if a reviewed local name or anchor changes while research approval is suspended',async()=>{
  const f=fixture();registerPerson(openVault(f.vaultDirectory),{id:'local-person',name:'Fixture Person',state:'active',merged:[],sighted_at:'2026-10-04T00:00:00Z',anchors:[{kind:'linkedin',value:'https://linkedin.com/in/fixture-person',context:'W',verified:true}]});
  const world=loadWorld(openVault(f.vaultDirectory)),enrich=vi.fn(async(_input:{name:string;linkedin_url:string;context:string})=>result());
  const tools=createNeonCapabilities({...f.options,world:()=>world,enrich});const execute=(id:string,input:unknown)=>tools.find(t=>t.id===id)!.execute(input,{signal:undefined,threadId:'fixture',resourceId:'fixture',toolCallId:'fixture'});
  const prepared=await execute('prepare_person_research',{contextId:'W',personId:'local-person',context:'Reviewed scope'});
  world.persons[0].name='Changed after suspension';await expect(execute('enrich_person',prepared)).rejects.toThrow('Reviewed local identity changed');
  world.persons[0].name='Fixture Person';world.persons[0].anchors[0].value='https://linkedin.com/in/another-person';await expect(execute('enrich_person',prepared)).rejects.toThrow('Reviewed local identity changed');
  expect(enrich).not.toHaveBeenCalled();
 });
 it('requires all outgoing prospect fields in native approval and keeps explicit context unchanged after goal edits',async()=>{
  const f=fixture(),enrich=vi.fn(async(_input:{name:string;linkedin_url:string;context:string})=>result());
  const tool=createNeonCapabilities({...f.options,enrich}).find(t=>t.id==='research_prospect')!;const context={signal:undefined,threadId:'fixture',resourceId:'fixture',toolCallId:'fixture'};
  const payload={name:'Fixture Person',linkedin_url:'https://www.linkedin.com/in/fixture-person',context:'Reviewed explicit context'};
  await expect(tool.execute({contextId:'W',payload:{name:payload.name,linkedin_url:payload.linkedin_url}},context)).rejects.toThrow();expect(enrich).not.toHaveBeenCalled();
  f.state.setGoal('A later unrelated goal');await tool.execute({contextId:'W',payload},context);expect(enrich).toHaveBeenCalledExactlyOnceWith(payload,undefined);
 });
 it('checks the reviewed sponsor target before constructing any remote SDK',async()=>{
  const f=fixture();const tool=createNeonCapabilities(f.options).find(t=>t.id==='prepare_snapshot_sharing')!;expect(tool.requiresApproval).toBe(true);
  await expect(tool.execute({databaseScope:'unapproved.example/database'},{signal:undefined,threadId:'fixture',resourceId:'fixture',toolCallId:'fixture'})).rejects.toThrow('Reviewed resource');
 });
});
