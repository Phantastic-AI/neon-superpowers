import type { OperatorStep } from './action-policy';

export interface DeterministicOperatorPlanInput {
  goal: string;
  instructions: string;
}

export interface DeterministicOperatorPlan {
  startUrl: string;
  steps: OperatorStep[];
}

const EMAIL_PATTERN = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;

export function firstUrlFromText(value: string): string | null {
  const match = value.match(/https?:\/\/[^\s)\]}>,"']+/i);
  return match ? match[0].replace(/[.,;:!?]+$/g, '') : null;
}

export function initialUrlForOperatorTask(goal: string): string {
  return firstUrlFromText(goal) ?? `https://www.google.com/search?q=${encodeURIComponent(goal)}`;
}

function firstEmail(value: string): string | undefined {
  return value.match(EMAIL_PATTERN)?.[0];
}

function requestsEmailDraft(value: string): boolean {
  return /\b(write|draft|email|respond|reply|message)\b/i.test(value) && EMAIL_PATTERN.test(value);
}

export function planDeterministicOperatorSteps(input: DeterministicOperatorPlanInput): DeterministicOperatorPlan {
  const taskText = `${input.goal}\n${input.instructions}`;
  const startUrl = initialUrlForOperatorTask(input.goal);
  const draftStep: OperatorStep = requestsEmailDraft(taskText)
    ? { kind: 'draft_email', recipient: firstEmail(taskText) }
    : { kind: 'draft_note' };

  return {
    startUrl,
    steps: [
      { kind: 'navigate', targetUrl: startUrl },
      { kind: 'observe' },
      draftStep,
      { kind: 'approval_stop' },
    ],
  };
}
