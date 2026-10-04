import { describe, expect, it } from 'vitest';
import {
  canonicalPayloadHash,
  defaultSideEffectClassForKind,
  validateBrowserAction,
  type ApprovalToken,
  type BrowserAction,
  type BrowserTargetRef,
} from '../browser-actions';

const target: BrowserTargetRef = {
  runId: 'run-1',
  targetId: 'target-1',
  pageOrigin: 'https://example.com',
  currentUrl: 'https://example.com/form',
  profilePathHash: 'profile-hash',
};

function action(overrides: Partial<BrowserAction> = {}): BrowserAction {
  return {
    id: 'act-1',
    runId: 'run-1',
    target,
    kind: 'observe',
    sideEffectClass: 'read_only',
    params: {},
    preconditionSummary: 'Target is bound to the run.',
    expectedPostcondition: 'Visible page state is captured.',
    ...overrides,
  };
}

function approvalToken(overrides: Partial<ApprovalToken> = {}): ApprovalToken {
  return {
    approvalId: 'approval-1',
    runId: 'run-1',
    actionType: 'remote_record_update',
    targetOrigin: 'https://example.com',
    targetId: 'target-1',
    payloadHash: canonicalPayloadHash({ message: 'hello', field: 'body' }),
    rangeOrSelector: '#message',
    expiresAt: '2026-05-14T18:00:00.000Z',
    approvedAt: '2026-05-14T17:45:00.000Z',
    ...overrides,
  };
}

describe('BrowserAction authority contract', () => {
  it('classifies browser actions by their default side-effect class', () => {
    expect(defaultSideEffectClassForKind('observe')).toBe('read_only');
    expect(defaultSideEffectClassForKind('screenshot')).toBe('read_only');
    expect(defaultSideEffectClassForKind('typeText')).toBe('local_input');
    expect(defaultSideEffectClassForKind('pasteText')).toBe('local_input');
    expect(defaultSideEffectClassForKind('click')).toBe('local_input');
  });

  it('accepts supported read-only and local-input actions without an approval token', () => {
    expect(validateBrowserAction(action(), new Date('2026-05-14T17:50:00.000Z'))).toEqual({ ok: true });
    expect(
      validateBrowserAction(
        action({
          kind: 'typeText',
          sideEffectClass: 'local_input',
          params: { selector: '#q', text: 'browser safety terms' },
        }),
        new Date('2026-05-14T17:50:00.000Z'),
      ),
    ).toEqual({ ok: true });
  });

  it('rejects unsupported action kinds', () => {
    const result = validateBrowserAction(action({ kind: 'evaluateJavascript' as BrowserAction['kind'] }));
    expect(result).toEqual({ ok: false, reason: 'Unsupported browser action kind: evaluateJavascript' });
  });

  it('rejects remote mutation candidates without a matching approval token', () => {
    const result = validateBrowserAction(
      action({
        kind: 'pasteText',
        sideEffectClass: 'remote_mutation_candidate',
        params: { payloadHash: canonicalPayloadHash({ message: 'hello', field: 'body' }) },
      }),
      new Date('2026-05-14T17:50:00.000Z'),
    );

    expect(result).toEqual({ ok: false, reason: 'Remote mutation candidate requires an approval token.' });
  });

  it('accepts a remote mutation candidate only with a live token bound to run, target, origin, and payload hash', () => {
    const payloadHash = canonicalPayloadHash({ message: 'hello', field: 'body' });
    const result = validateBrowserAction(
      action({
        kind: 'pasteText',
        sideEffectClass: 'remote_mutation_candidate',
        params: { payloadHash, text: 'Alice\taligned\tnotes' },
        approvalToken: approvalToken({ payloadHash }),
      }),
      new Date('2026-05-14T17:50:00.000Z'),
    );

    expect(result).toEqual({ ok: true });
  });

  it('rejects expired and mismatched approval tokens', () => {
    const payloadHash = canonicalPayloadHash({ message: 'hello', field: 'body' });
    const base = action({
      kind: 'pasteText',
      sideEffectClass: 'remote_mutation_candidate',
      params: { payloadHash },
      approvalToken: approvalToken({ payloadHash }),
    });

    expect(validateBrowserAction(base, new Date('2026-05-14T18:00:01.000Z'))).toEqual({
      ok: false,
      reason: 'Approval token expired.',
    });
    expect(validateBrowserAction({ ...base, approvalToken: approvalToken({ runId: 'run-2', payloadHash }) }, new Date('2026-05-14T17:50:00.000Z'))).toEqual({
      ok: false,
      reason: 'Approval token runId does not match action runId.',
    });
    expect(validateBrowserAction({ ...base, approvalToken: approvalToken({ targetId: 'target-2', payloadHash }) }, new Date('2026-05-14T17:50:00.000Z'))).toEqual({
      ok: false,
      reason: 'Approval token targetId does not match bound target.',
    });
    expect(validateBrowserAction({ ...base, approvalToken: approvalToken({ targetOrigin: 'https://mail.google.com', payloadHash }) }, new Date('2026-05-14T17:50:00.000Z'))).toEqual({
      ok: false,
      reason: 'Approval token origin does not match bound target origin.',
    });
    expect(
      validateBrowserAction(
        {
          ...base,
          approvalToken: approvalToken({ payloadHash: canonicalPayloadHash({ message: 'different', field: 'body' }) }),
        },
        new Date('2026-05-14T17:50:00.000Z'),
      ),
    ).toEqual({ ok: false, reason: 'Approval token payload hash does not match action payload hash.' });
  });

  it('rejects remote-site-facing payload strings that mention agent or copilot automation', () => {
    const payloadHash = canonicalPayloadHash({ message: 'My AI agent found your thesis.' });
    const result = validateBrowserAction(
      action({
        kind: 'pasteText',
        sideEffectClass: 'remote_mutation_candidate',
        params: { payloadHash, nested: { message: 'My AI agent found your thesis.' } },
        approvalToken: approvalToken({ actionType: 'send_email', targetOrigin: target.pageOrigin, payloadHash }),
      }),
      new Date('2026-05-14T17:50:00.000Z'),
    );

    expect(result).toEqual({
      ok: false,
      reason: 'Remote-site-facing copy must speak in the user voice and must not mention agent/copilot automation.',
    });
  });
});

describe('canonical payload hashing', () => {
  it('is stable under object key order and changes when values change', () => {
    const left = canonicalPayloadHash({ selector: '#message', values: [['Hello', 'review']], meta: { origin: 'example', field: 'body' } });
    const right = canonicalPayloadHash({ values: [['Hello', 'review']], meta: { field: 'body', origin: 'example' }, selector: '#message' });
    const changed = canonicalPayloadHash({ values: [['Hello', 'changed']], meta: { field: 'body', origin: 'example' }, selector: '#message' });

    expect(canonicalPayloadHash('abc')).toBe('6cc43f858fbb763301637b5af970e2a46b46f461f27e5a0f41e009c59b827b25');
    expect(left).toMatch(/^[a-f0-9]{64}$/);
    expect(left).toBe(right);
    expect(left).not.toBe(changed);
  });

});
