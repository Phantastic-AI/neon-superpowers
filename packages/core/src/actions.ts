import { createId, nowIso } from './id';
import type { DraftAction, ExternalActionType } from './types';

export interface DraftActionInput {
  missionItemId: string;
  actionType: ExternalActionType;
  targetSurface: string;
  payload: Record<string, unknown>;
}

const REMOTE_FORBIDDEN_PATTERNS = [
  /\bmy\s+(ai\s+)?agent\b/i,
  /\bmy\s+copilot\b/i,
  /\bbrowser\s+agent\b/i,
  /\bautomated\s+agent\b/i,
  /\bai\s+copilot\b/i,
];

export function validateRemoteFacingCopy(copy: string): { ok: true } | { ok: false; reason: string } {
  const match = REMOTE_FORBIDDEN_PATTERNS.find((pattern) => pattern.test(copy));
  if (match) {
    return {
      ok: false,
      reason: 'Remote-site-facing copy must speak in the user voice and must not mention agent/copilot automation.',
    };
  }
  return { ok: true };
}

export function createDraftAction(input: DraftActionInput): DraftAction {
  for (const value of Object.values(input.payload)) {
    if (typeof value === 'string') {
      const validation = validateRemoteFacingCopy(value);
      if (!validation.ok) {
        throw new Error(validation.reason);
      }
    }
  }

  return {
    id: createId('draft'),
    missionItemId: input.missionItemId,
    actionType: input.actionType,
    targetSurface: input.targetSurface,
    payload: input.payload,
    requiresApproval: true,
    approvalStatus: 'pending',
    createdAt: nowIso(),
  };
}
