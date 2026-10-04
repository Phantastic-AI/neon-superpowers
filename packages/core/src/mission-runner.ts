import { createDraftAction } from './actions';
import { createAuditEvent } from './audit';
import { createId, nowIso } from './id';
import type { BrowserItemInput, BrowserPageContext, FitStatus, Mission, MissionItem } from './types';

export interface CreateMissionInput {
  name: string;
  thesis: string;
  items: BrowserItemInput[];
}

export function createMission(input: CreateMissionInput): Mission {
  const now = nowIso();
  return {
    id: createId('mission'),
    name: input.name,
    thesis: input.thesis,
    status: 'ready',
    items: input.items.map((item) => ({
      ...item,
      status: 'queued',
      fit: 'unknown',
      evidence: [],
    })),
    auditLog: [],
    draftActions: [],
    createdAt: now,
    updatedAt: now,
  };
}

function taskTokens(thesis: string): string[] {
  return thesis
    .toLowerCase()
    .replace(/[^a-z0-9+\/\s-]/g, ' ')
    .split(/[\s/+,]+/)
    .filter((token) => token.length > 1 && !['and', 'the', 'for', 'with'].includes(token));
}

function inferGenericFit(context: BrowserPageContext, thesis: string): FitStatus {
  const text = `${context.title ?? ''}\n${context.visibleText ?? ''}\n${context.selectedText ?? ''}`.toLowerCase();
  const matches = taskTokens(thesis).filter((token) => text.includes(token));
  return matches.length > 0 ? 'aligned' : text.length > 80 ? 'unclear' : 'unknown';
}

function summarizeContext(context: BrowserPageContext): string {
  const text = (context.selectedText || context.visibleText || context.title || context.url)
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > 240 ? `${text.slice(0, 239).trim()}…` : text;
}

function createLocalResearchDraft(item: MissionItem, context: BrowserPageContext) {
  return createDraftAction({
    missionItemId: item.id,
    actionType: 'save_research_note',
    targetSurface: 'local',
    payload: {
      title: item.name,
      sourceUrl: context.url,
      summary: item.summary,
      evidence: item.evidence.map((entry) => entry.summary),
    },
  });
}

export function processBrowserObservation(mission: Mission, itemId: string, context: BrowserPageContext): Mission {
  const item = mission.items.find((candidate) => candidate.id === itemId);
  if (!item) throw new Error(`Unknown browser item: ${itemId}`);

  const nextItems = mission.items.map((candidate) => ({ ...candidate, evidence: [...candidate.evidence] }));
  const nextItem = nextItems.find((candidate) => candidate.id === itemId)!;
  const auditLog = [...mission.auditLog];
  const draftActions = [...mission.draftActions];

  auditLog.push(createAuditEvent({
    missionId: mission.id,
    missionItemId: itemId,
    type: 'observation.captured',
    actor: 'assistant',
    source: context.url,
    details: { mode: 'browser_page', title: context.title },
  }));

  const fit = inferGenericFit(context, mission.thesis);
  const summary = fit === 'aligned'
    ? `Visible browser context overlaps with instructions: ${mission.thesis}.`
    : summarizeContext(context);
  const evidence = [{ sourceUrl: context.url, label: 'browser_page', summary, observed: true }];

  nextItem.fit = fit;
  nextItem.summary = summary;
  nextItem.evidence.push(...evidence);
  nextItem.notes = [nextItem.notes, summary].filter(Boolean).join('\n');
  nextItem.suggestedNextAction = fit === 'aligned' ? 'Prepare local draft/review output.' : 'Review observed page evidence.';
  nextItem.status = fit === 'aligned' ? 'needs_approval' : 'evaluating';

  auditLog.push(createAuditEvent({
    missionId: mission.id,
    missionItemId: itemId,
    type: 'browser_page.evaluated',
    actor: 'assistant',
    source: context.url,
    details: { fit, summary },
  }));

  if (fit === 'aligned') {
    const draft = createLocalResearchDraft(nextItem, context);
    draftActions.push(draft);
    auditLog.push(createAuditEvent({
      missionId: mission.id,
      missionItemId: itemId,
      type: 'draft.created',
      actor: 'assistant',
      source: 'local-draft',
      details: { actionType: draft.actionType, draftId: draft.id },
    }));
  }

  return {
    ...mission,
    items: nextItems,
    auditLog,
    draftActions,
    status: 'running',
    updatedAt: nowIso(),
  };
}
