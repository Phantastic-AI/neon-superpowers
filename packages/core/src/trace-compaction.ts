export interface RunTranscriptEvent {
  id: string;
  title: string;
  body: string;
  status: 'done' | 'running' | 'queued' | 'blocked' | string;
}

export interface TraceCompactionOptions {
  maxEvents: number;
  keepTail: number;
  maxChars: number;
  nowIso?: string;
}

export interface TraceCheckpoint {
  id: string;
  eventCount: number;
  summary: string;
  createdAt: string;
}

export interface TraceCompactionResult<T extends RunTranscriptEvent> {
  compacted: boolean;
  visibleEvents: T[];
  checkpoint: TraceCheckpoint | null;
}

function transcriptChars(events: RunTranscriptEvent[]): number {
  return events.reduce((total, event) => total + event.title.length + event.body.length, 0);
}

function compactText(value: string, maxLength: number): string {
  const text = value.replace(/\s+/g, ' ').trim();
  return text.length > maxLength ? `${text.slice(0, maxLength - 1).trim()}…` : text;
}

function summarizeEvents(events: RunTranscriptEvent[]): string {
  if (events.length === 0) return 'No prior events.';
  const first = events[0];
  const last = events[events.length - 1];
  const blocked = events.filter((event) => event.status === 'blocked').length;
  const running = events.filter((event) => event.status === 'running').length;
  const statusBits = [
    `${events.length} earlier events`,
    blocked > 0 ? `${blocked} blocked` : '',
    running > 0 ? `${running} running` : '',
  ].filter(Boolean).join(' · ');

  return compactText(`${statusBits}. First: ${first.title} — ${first.body}. Last compacted: ${last.title} — ${last.body}.`, 420);
}

export function compactRunTranscript<T extends RunTranscriptEvent>(
  events: T[],
  options: TraceCompactionOptions,
): TraceCompactionResult<T> {
  const shouldCompact = events.length > options.maxEvents || transcriptChars(events) > options.maxChars;
  if (!shouldCompact) {
    return { compacted: false, visibleEvents: events, checkpoint: null };
  }

  const keepTail = Math.max(1, Math.min(options.keepTail, events.length));
  const compactedEvents = events.slice(0, -keepTail);
  const tail = events.slice(-keepTail);
  const createdAt = options.nowIso ?? new Date().toISOString();
  const summary = summarizeEvents(compactedEvents);
  const checkpoint: TraceCheckpoint = {
    id: `trace-checkpoint-${Date.parse(createdAt) || Date.now()}-${compactedEvents.length}`,
    eventCount: compactedEvents.length,
    summary,
    createdAt,
  };
  const summaryEvent = {
    id: checkpoint.id,
    title: 'Trace compacted',
    body: summary,
    status: 'done',
  } as T;

  return {
    compacted: true,
    visibleEvents: [summaryEvent, ...tail],
    checkpoint,
  };
}
