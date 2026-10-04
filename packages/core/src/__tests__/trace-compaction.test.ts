import { describe, expect, it } from 'vitest';
import { compactRunTranscript } from '../trace-compaction';

describe('run trace compaction', () => {
  it('keeps short traces unchanged', () => {
    const events = [
      { id: '1', title: 'Start', body: 'Started run.', status: 'done' as const },
      { id: '2', title: 'Read', body: 'Read page.', status: 'done' as const },
    ];

    const compacted = compactRunTranscript(events, { maxEvents: 5, keepTail: 2, maxChars: 500 });

    expect(compacted.compacted).toBe(false);
    expect(compacted.visibleEvents).toEqual(events);
    expect(compacted.checkpoint).toBeNull();
  });

  it('summarizes old events and keeps the recent tail when event count grows', () => {
    const events = Array.from({ length: 8 }, (_, index) => ({
      id: `event-${index}`,
      title: `Step ${index}`,
      body: `Did browser work ${index}`,
      status: index === 7 ? 'running' as const : 'done' as const,
    }));

    const compacted = compactRunTranscript(events, { maxEvents: 5, keepTail: 3, maxChars: 10_000 });

    expect(compacted.compacted).toBe(true);
    expect(compacted.checkpoint).toMatchObject({ eventCount: 5 });
    expect(compacted.visibleEvents).toHaveLength(4);
    expect(compacted.visibleEvents[0]).toMatchObject({ title: 'Trace compacted', status: 'done' });
    expect(compacted.visibleEvents.slice(1).map((event) => event.id)).toEqual(['event-5', 'event-6', 'event-7']);
    expect(compacted.visibleEvents[0].body).toContain('Step 0');
    expect(compacted.visibleEvents[0].body).toContain('Step 4');
  });

  it('also compacts when transcript text is too large', () => {
    const events = [
      { id: '1', title: 'Huge', body: 'x'.repeat(200), status: 'done' as const },
      { id: '2', title: 'Tail', body: 'keep me', status: 'done' as const },
    ];

    const compacted = compactRunTranscript(events, { maxEvents: 50, keepTail: 1, maxChars: 100 });

    expect(compacted.compacted).toBe(true);
    expect(compacted.visibleEvents.map((event) => event.title)).toEqual(['Trace compacted', 'Tail']);
    expect(compacted.checkpoint?.summary.length).toBeLessThan(500);
  });
});
