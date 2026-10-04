import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LaunchState } from './state.js';
const dirs:string[]=[];afterEach(()=>dirs.splice(0).forEach(p=>rmSync(p,{recursive:true,force:true})));
it('persists goal, steering and provider receipts across reopening',()=>{const dir=mkdtempSync(join(tmpdir(),'neon-state-'));dirs.push(dir);const state=new LaunchState(dir);state.setGoal('Plan a dinner');state.setShortlist([{personId:'person-1',rationale:'Shared interests',sources:['https://example.test/about']}]);state.selectPeople(['person-1']);state.receipt('Exa','research',{requestId:'request-1',cost:0.02});const reopened=new LaunchState(dir).read();expect(reopened.goal?.text).toBe('Plan a dinner');expect(reopened.selectedPersonIds).toEqual(['person-1']);expect(reopened.receipts[0].sponsor).toBe('Exa');});
it('does not accept a shortlist selection that has no source record',()=>{const dir=mkdtempSync(join(tmpdir(),'neon-state-'));dirs.push(dir);const s=new LaunchState(dir);expect(()=>s.selectPeople(['invented'])).toThrow();});
