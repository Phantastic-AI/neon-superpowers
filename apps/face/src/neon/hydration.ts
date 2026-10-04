import { ExportedMessageRepository } from '@assistant-ui/react';
import { fromAgUiMessages } from '@assistant-ui/react-ag-ui';

/** Restore the stored AG-UI transcript without inventing a successful action. */
export function restoreConversation(snapshot: {messages: unknown[]; pending: unknown[]}) {
  const messages = fromAgUiMessages(snapshot.messages, {showThinking:false});
  if (snapshot.pending.length) {
    let last = [...messages].reverse().find(message => message.role === 'assistant');
    if (!last) {
      last = {id:crypto.randomUUID(),role:'assistant',content:[]};
      messages.push(last);
    }
    const position = messages.indexOf(last);
    messages[position] = {
      ...last,
      status:{type:'requires-action',reason:'interrupt'},
      metadata:{...last.metadata,custom:{...last.metadata?.custom,agui:{interrupts:snapshot.pending}}},
    };
  }
  return ExportedMessageRepository.fromArray(messages);
}
