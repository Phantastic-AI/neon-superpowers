import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
export interface ShortlistedPerson { personId: string; rationale: string; sources: string[] }
export interface LaunchReceipt { id: string; at: string; sponsor: string; action: string; result: unknown }
export interface LaunchSnapshot {
 version: 1;
 goal: {id: string; text: string; createdAt: string} | null;
 shortlist: ShortlistedPerson[];
 selectedPersonIds: string[];
 receipts: LaunchReceipt[];
 notes: string[];
}
/** Owned by the one loopback sidecar. Provider effects use ApprovalLedger. */
export class LaunchState {
 private path: string;
 constructor(private dir: string) {mkdirSync(dir,{recursive:true,mode:0o700});this.path=join(dir,'launch.json');}
 read(): LaunchSnapshot {
  if(!existsSync(this.path))return {version:1,goal:null,shortlist:[],selectedPersonIds:[],receipts:[],notes:[]};
  const data=JSON.parse(readFileSync(this.path,'utf8')) as LaunchSnapshot;
  if(data.version!==1)throw new Error('Unsupported local state version');
  return data;
 }
 private change(fn:(state:LaunchSnapshot)=>void): LaunchSnapshot {
  const state=this.read();fn(state);
  const temporary=this.path+'.'+randomUUID()+'.tmp';const fd=openSync(temporary,'wx',0o600);
  try{writeFileSync(fd,JSON.stringify(state,null,2));fsyncSync(fd);}finally{closeSync(fd);}
  renameSync(temporary,this.path);
  const directory=openSync(this.dir,'r');try{fsyncSync(directory);}finally{closeSync(directory);}
  return structuredClone(state);
 }
 setGoal(text:string) {if(!text.trim()||text.length>10000)throw new Error('Goal must contain 1–10000 characters');return this.change(s=>{s.goal={id:randomUUID(),text,createdAt:new Date().toISOString()};s.shortlist=[];s.selectedPersonIds=[];s.notes=[];});}
 setShortlist(people:ShortlistedPerson[]) {
  if(people.length>50 || new Set(people.map(p=>p.personId)).size!==people.length || people.some(p=>!p.personId||!p.rationale||!p.sources.length))throw new Error('Every unique shortlisted person needs rationale and sources');
  return this.change(s=>{s.shortlist=structuredClone(people);s.selectedPersonIds=s.selectedPersonIds.filter(id=>people.some(p=>p.personId===id));});
 }
 selectPeople(ids:string[]) {return this.change(s=>{if(ids.some(id=>!s.shortlist.some(p=>p.personId===id)))throw new Error('Select people from the sourced shortlist');s.selectedPersonIds=[...new Set(ids)];});}
 note(text:string) {return this.change(s=>{s.notes.push(text.slice(0,10000));});}
 receipt(sponsor:string,action:string,result:unknown) {const receipt={id:randomUUID(),at:new Date().toISOString(),sponsor,action,result};this.change(s=>{s.receipts.push(receipt);});return receipt;}
}
