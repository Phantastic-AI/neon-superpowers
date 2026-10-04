import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

function canonical(value: unknown): string {
  if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('Approval data must be finite JSON');
  if (value === null || typeof value !== 'object') {
    const result = JSON.stringify(value);
    if (result === undefined) throw new Error('Approval payload must be JSON');
    return result;
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new Error('Approval data must be plain JSON');
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
}
export const payloadHash = (value: unknown): string => createHash('sha256').update(canonical(value)).digest('hex');
export interface PreparedAction { id: string; hash: string; payload: unknown; createdAt: string; approvalId?: string; revokedAt?: string }
interface Approval { id: string; draftId: string; hash: string; approvedAt: string; operationKey?: string }
interface Operation { approvalId: string; hash: string; state: 'reserved' | 'uncertain' | 'complete'; startedAt: string; completedAt?: string; receipt?: unknown }
interface State { version: 1; drafts: Record<string, PreparedAction>; approvals: Record<string, Approval>; operations: Record<string, Operation> }
const empty = (): State => ({version: 1, drafts: {}, approvals: {}, operations: {}});

/** Local single-app approval ledger. Every mutation holds a process-independent
 * exclusive lock and commits by fsync + rename. A stale lock is never silently
 * broken: this deliberately fails closed until the interrupted process is checked.
 * Reserved/uncertain sends cannot be retried automatically, even after restart.
 */
export class ApprovalLedger {
  private readonly path: string;
  private readonly lock: string;
  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.path = join(dir, 'approvals.json');
    this.lock = join(dir, 'approvals.lock');
  }
  private read(): State {
    if (!existsSync(this.path)) return empty();
    const state = JSON.parse(readFileSync(this.path, 'utf8')) as State;
    if (state.version !== 1 || !state.drafts || !state.approvals || !state.operations) throw new Error('Invalid approval ledger');
    return state;
  }
  private change<T>(action: (state: State) => T): T {
    const lock = openSync(this.lock, 'wx', 0o600);
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      const state = this.read();
      const result = action(state);
      const fd = openSync(temporary, 'wx', 0o600);
      try { writeFileSync(fd, JSON.stringify(state)); fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(temporary, this.path);
      const directory = openSync(this.dir, 'r');
      try { fsyncSync(directory); } finally { closeSync(directory); }
      return structuredClone(result);
    } finally {
      if (existsSync(temporary)) unlinkSync(temporary);
      closeSync(lock);
      unlinkSync(this.lock);
    }
  }
  inspect(): State { return this.read(); }
  prepare(payload: unknown): PreparedAction {
    const copy = JSON.parse(canonical(payload));
    return this.change(state => {
      const draft: PreparedAction = { id: randomUUID(), hash: payloadHash(copy), payload: copy, createdAt: new Date().toISOString() };
      state.drafts[draft.id] = draft;
      return draft;
    });
  }
  private revokeIn(state: State, draftId: string): void {
    const draft = Object.hasOwn(state.drafts, draftId) ? state.drafts[draftId] : undefined;
    if (!draft) throw new Error('Draft does not exist');
    if (draft.approvalId && state.approvals[draft.approvalId]?.operationKey) throw new Error('Draft already dispatched; reconcile outcome first');
    draft.revokedAt = new Date().toISOString();
  }
  revoke(draftId: string): void {
    this.change(state => { this.revokeIn(state, draftId); return null; });
  }
  replace(draftId: string, payload: unknown): PreparedAction {
    const copy = JSON.parse(canonical(payload));
    return this.change(state => {
      this.revokeIn(state, draftId);
      const draft: PreparedAction = {id: randomUUID(), hash: payloadHash(copy), payload: copy, createdAt: new Date().toISOString()};
      state.drafts[draft.id] = draft;
      return draft;
    });
  }
  approve(draftId: string, reviewedHash: string): Approval {
    if (typeof draftId !== 'string' || !draftId || typeof reviewedHash !== 'string' || !/^[a-f0-9]{64}$/.test(reviewedHash)) throw new Error('Draft changed or invalid approval');
    return this.change(state => {
      const draft = Object.hasOwn(state.drafts, draftId) ? state.drafts[draftId] : undefined;
      if (!draft || draft.hash !== reviewedHash) throw new Error('Draft changed or no longer exists');
      if (draft.revokedAt) throw new Error('Draft revoked');
      if (draft.approvalId) return state.approvals[draft.approvalId];
      const approval: Approval = { id: randomUUID(), draftId, hash: draft.hash, approvedAt: new Date().toISOString() };
      state.approvals[approval.id] = approval;
      draft.approvalId = approval.id;
      return approval;
    });
  }
  async run<T>(payload: unknown, auth: { approvalId: string; idempotencyKey: string }, dispatch: () => Promise<T>): Promise<T> {
    if (!auth.idempotencyKey?.trim()) throw new Error('Missing idempotency key');
    const hash = payloadHash(payload);
    // Hash the supplied key so arbitrary user input cannot name object prototypes.
    const key = payloadHash(auth.idempotencyKey);
    const reservation = this.change(state => {
      const approval = Object.hasOwn(state.approvals, auth.approvalId) ? state.approvals[auth.approvalId] : undefined;
      if (!approval) throw new Error('Missing approval');
      if (state.drafts[approval.draftId]?.revokedAt) throw new Error('Approval revoked by draft change');
      if (approval.hash !== hash) throw new Error('Approval payload does not match reviewed content/account');
      if (approval.operationKey && approval.operationKey !== key) throw new Error('Approval already consumed');
      const previous = state.operations[key];
      if (previous) {
        if (previous.hash !== hash || previous.approvalId !== auth.approvalId) throw new Error('Idempotency key belongs to another action');
        if (previous.state !== 'complete') throw new Error('Dispatch outcome uncertain; reconcile provider receipt before retrying');
        return { replay: true as const, receipt: previous.receipt as T };
      }
      approval.operationKey = key;
      state.operations[key] = {approvalId: auth.approvalId, hash, state: 'reserved', startedAt: new Date().toISOString()};
      return {replay: false as const};
    });
    if (reservation.replay) return reservation.receipt;
    try {
      const receipt = await dispatch();
      // Undefined/non-JSON receipts never count as verified dispatch completion.
      const persistedReceipt = JSON.parse(canonical(receipt)) as T;
      this.change(state => {
        const op = state.operations[key];
        op.state = 'complete'; op.receipt = persistedReceipt; op.completedAt = new Date().toISOString();
        return null;
      });
      return persistedReceipt;
    } catch (error) {
      this.change(state => { state.operations[key].state = 'uncertain'; return null; });
      throw error;
    }
  }
}
