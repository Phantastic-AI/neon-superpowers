import { describe, expect, it } from 'vitest';
import { planDeterministicOperatorSteps } from '../step-planner';
import { evaluateOperatorStep } from '../action-policy';

describe('deterministic operator loop contract', () => {
  it('plans the V1 Play path as navigate → observe → draft → approval stop', () => {
    const plan = planDeterministicOperatorSteps({
      goal: 'Go to https://example.com/terms and write to customer wendy@test.com about platform use.',
      instructions: 'Create a local draft only.',
    });

    expect(plan.steps.map((step) => step.kind)).toEqual(['navigate', 'observe', 'draft_email', 'approval_stop']);
    expect(plan.steps[0]).toMatchObject({ kind: 'navigate', targetUrl: 'https://example.com/terms' });
    expect(plan.steps[2]).toMatchObject({ kind: 'draft_email', recipient: 'wendy@test.com' });
    expect(plan.steps[3]).toMatchObject({ kind: 'approval_stop' });
  });

  it('falls back to a search navigation when the goal has no explicit URL', () => {
    const plan = planDeterministicOperatorSteps({ goal: 'research browser safety terms', instructions: '' });

    expect(plan.steps[0].kind).toBe('navigate');
    expect(plan.steps[0]).toMatchObject({ targetUrl: 'https://www.google.com/search?q=research%20browser%20safety%20terms' });
  });

  it('blocks remote mutation steps unless they are local drafts or approval stops', () => {
    expect(evaluateOperatorStep({ kind: 'navigate', targetUrl: 'https://example.com/terms' })).toEqual({ ok: true });
    expect(evaluateOperatorStep({ kind: 'observe' })).toEqual({ ok: true });
    expect(evaluateOperatorStep({ kind: 'draft_email', recipient: 'wendy@test.com' })).toEqual({ ok: true });
    expect(evaluateOperatorStep({ kind: 'approval_stop' })).toEqual({ ok: true });

    expect(evaluateOperatorStep({ kind: 'send_email', recipient: 'wendy@test.com' })).toEqual({
      ok: false,
      reason: 'V1 may prepare email drafts only; it must not send email.',
    });
  });
});
