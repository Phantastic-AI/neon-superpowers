import {describe,it,expect} from 'vitest';
import {restoreConversation} from './hydration';

describe('persisted AG-UI conversation',()=>{
  it('restores original text and roles without generating a run',()=>{
    const restored=restoreConversation({messages:[{id:'user',role:'user',content:'Dinner for six'},{id:'lois',role:'assistant',content:'Who should join?'}],pending:[]});
    expect(restored.messages.map(item=>[item.message.id,item.message.role,item.message.content])).toEqual([
      ['user','user',[{type:'text',text:'Dinner for six'}]],['lois','assistant',[{type:'text',text:'Who should join?'}]],
    ]);
  });
  it('restores the exact pending action as an actionable interruption',()=>{
    const pending=[{id:'approval-1',reason:'tool-approval',metadata:{mastra:{toolName:'enrich',args:{personId:'person-1'}}}}];
    const restored=restoreConversation({messages:[{id:'lois',role:'assistant',content:'Please review.'}],pending});
    const assistant=restored.messages[0].message;
    expect(assistant.status).toEqual({type:'requires-action',reason:'interrupt'});
    expect(assistant.metadata.custom.agui).toEqual({interrupts:pending});
  });
  it('shows an approval-only message when the stored run has no assistant text',()=>{
    const restored=restoreConversation({messages:[],pending:[{id:'approval-1',reason:'tool-approval'}]});
    expect(restored.messages).toHaveLength(1);
    expect(restored.messages[0].message.role).toBe('assistant');
    expect(restored.messages[0].message.content).toEqual([]);
    expect(restored.messages[0].message.status).toEqual({type:'requires-action',reason:'interrupt'});
  });
});
