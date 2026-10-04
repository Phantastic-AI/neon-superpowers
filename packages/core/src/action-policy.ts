export type OperatorStep =
  | { kind: 'navigate'; targetUrl: string }
  | { kind: 'observe' }
  | { kind: 'draft_email'; recipient?: string }
  | { kind: 'draft_note' }
  | { kind: 'approval_stop' }
  | { kind: 'send_email'; recipient?: string }
  | { kind: 'submit_form' }
  | { kind: 'social_action' };

export type ActionPolicyResult = { ok: true } | { ok: false; reason: string };

const V1_ALLOWED_STEP_KINDS = new Set<OperatorStep['kind']>([
  'navigate',
  'observe',
  'draft_email',
  'draft_note',
  'approval_stop',
]);

export function evaluateOperatorStep(step: OperatorStep): ActionPolicyResult {
  if (V1_ALLOWED_STEP_KINDS.has(step.kind)) {
    return { ok: true };
  }

  if (step.kind === 'send_email') {
    return { ok: false, reason: 'V1 may prepare email drafts only; it must not send email.' };
  }

  return { ok: false, reason: `V1 may not execute remote mutation step: ${step.kind}.` };
}

export function assertOperatorStepAllowed(step: OperatorStep): void {
  const result = evaluateOperatorStep(step);
  if (!result.ok) {
    throw new Error(result.reason);
  }
}
