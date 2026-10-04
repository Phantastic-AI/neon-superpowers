import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ThreadScope, ThreadState, ThreadStateStore } from './transport.ts';

/** Local persistent store. Lock directories serialize writers across processes.
 * Abandoned locks fail closed; recovery requires stopping all sidecar processes.
 */
export function createFileThreadStateStore(directory: string): ThreadStateStore {
 return {async update(scope: ThreadScope, transform) {
  await mkdir(directory,{recursive:true,mode:0o700});
  const key=createHash('sha256').update(JSON.stringify(scope)).digest('hex');
  const lock=join(directory,key+'.lock');
  let acquired=false;
  for(let attempt=0;attempt<200;attempt++) {
   try {await mkdir(lock);acquired=true;break;}catch(error){
    if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;
    await new Promise(resolve=>setTimeout(resolve,15));
   }
  }
  if(!acquired)throw new Error('Thread state is locked');
  const file=join(directory,key+'.json');
  const temporary=file+'.'+randomUUID()+'.tmp';
  try {
   let current: ThreadState|undefined;
   try {current=JSON.parse(await readFile(file,'utf8'));}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
   const next=transform(current);
   await writeFile(temporary,JSON.stringify(next),{mode:0o600});
   await rename(temporary,file);
   return structuredClone(next);
  } finally {await rm(temporary,{force:true});await rm(lock,{recursive:true,force:true});}
 }};
}
