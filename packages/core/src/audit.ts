import { createId, nowIso } from './id';
import type { AuditEvent } from './types';

export function createAuditEvent(input: Omit<AuditEvent, 'id' | 'createdAt'>): AuditEvent {
  return {
    id: createId('audit'),
    createdAt: nowIso(),
    ...input,
  };
}
