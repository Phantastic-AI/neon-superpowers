import { describe, expect, it } from 'vitest';
import { createDraftAction, validateRemoteFacingCopy } from '../actions';

describe('draft action approval gates', () => {
  it('requires approval for every external side effect', () => {
    const action = createDraftAction({
      missionItemId: 'item-1',
      actionType: 'send_email',
      targetSurface: 'gmail',
      payload: { to: 'founder@example.com', body: 'Good to meet you.' },
    });

    expect(action.requiresApproval).toBe(true);
    expect(action.approvalStatus).toBe('pending');
  });

  it('rejects remote-facing copy that names the software as agent or copilot', () => {
    expect(validateRemoteFacingCopy('My AI agent found your thesis.').ok).toBe(false);
    expect(validateRemoteFacingCopy('My copilot found your thesis.').ok).toBe(false);
    expect(validateRemoteFacingCopy('I saw your recent investment in applied AI.').ok).toBe(true);
  });
});
