import { describe, expect, it } from 'vitest';
import { createMission, processBrowserObservation } from '../mission-runner';

describe('browser mission runner', () => {
  it('records browser page evidence and creates a local research draft for aligned instructions', () => {
    const mission = createMission({
      name: 'Read current page',
      thesis: 'alpha software',
      items: [{ id: 'page-1', name: 'Current page', organization: 'Browser' }],
    });

    const updated = processBrowserObservation(mission, 'page-1', {
      url: 'https://example.com/terms',
      title: 'Terms of Service — Example Company',
      visibleText: 'Example Company is alpha software. Users are responsible for instructions and activity.',
      capturedAt: '2026-05-14T00:00:00.000Z',
    });

    expect(updated.items[0]).toMatchObject({ status: 'needs_approval', fit: 'aligned' });
    expect(updated.items[0].evidence[0]).toMatchObject({ sourceUrl: 'https://example.com/terms', label: 'browser_page', observed: true });
    expect(updated.draftActions[0]).toMatchObject({ actionType: 'save_research_note', targetSurface: 'local', requiresApproval: true, approvalStatus: 'pending' });
    expect(updated.auditLog.map((event) => event.type)).toEqual(expect.arrayContaining(['observation.captured', 'browser_page.evaluated', 'draft.created']));
  });

  it('keeps sparse observations in review without inventing remote actions', () => {
    const mission = createMission({
      name: 'Read current page',
      thesis: 'alpha software',
      items: [{ id: 'page-1', name: 'Current page' }],
    });

    const updated = processBrowserObservation(mission, 'page-1', {
      url: 'https://example.com',
      title: 'Example',
    });

    expect(updated.items[0]).toMatchObject({ status: 'evaluating', fit: 'unknown' });
    expect(updated.draftActions).toHaveLength(0);
  });

  it('fails fast for unknown browser items', () => {
    const mission = createMission({ name: 'Read', thesis: '', items: [] });
    expect(() => processBrowserObservation(mission, 'missing', { url: 'https://example.com' })).toThrow('Unknown browser item: missing');
  });
});
