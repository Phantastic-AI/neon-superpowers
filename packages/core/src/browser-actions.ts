import { validateRemoteFacingCopy } from './actions';

export const BROWSER_ACTION_KINDS = [
  'navigate',
  'observe',
  'click',
  'typeText',
  'pressKey',
  'scroll',
  'wait',
  'copyVisibleSelection',
  'pasteText',
  'screenshot',
] as const;

export type BrowserActionKind = (typeof BROWSER_ACTION_KINDS)[number];
export type SideEffectClass = 'read_only' | 'local_input' | 'remote_mutation_candidate' | 'approved_remote_mutation';
export type RemoteMutationActionType =
  | 'send_email'
  | 'social_action'
  | 'form_submit'
  | 'remote_record_update'
  | 'other_remote_mutation';

export interface BrowserTargetRef {
  runId: string;
  targetId: string;
  pageOrigin: string;
  currentUrl: string;
  profilePathHash: string;
}

export interface ApprovalToken {
  approvalId: string;
  runId: string;
  actionType: RemoteMutationActionType;
  targetOrigin: string;
  targetId: string;
  payloadHash: string;
  rangeOrSelector?: string;
  expiresAt: string;
  approvedAt: string;
}

export interface BrowserAction {
  id: string;
  runId: string;
  target: BrowserTargetRef;
  kind: BrowserActionKind;
  sideEffectClass: SideEffectClass;
  params: Record<string, unknown>;
  approvalToken?: ApprovalToken;
  preconditionSummary: string;
  expectedPostcondition: string;
}

export interface BrowserActionResult {
  actionId: string;
  target: BrowserTargetRef;
  pageContext?: {
    url: string;
    title?: string;
    visibleText?: string;
    selectedText?: string;
    screenshotDataUrl?: string;
    capturedAt?: string;
  } | null;
  screenshotDataUrl?: string | null;
  message: string;
}


export type BrowserActionValidation = { ok: true } | { ok: false; reason: string };

const BROWSER_ACTION_KIND_SET = new Set<string>(BROWSER_ACTION_KINDS);
const READ_ONLY_KINDS = new Set<BrowserActionKind>(['observe', 'screenshot', 'copyVisibleSelection']);
const LOCAL_INPUT_KINDS = new Set<BrowserActionKind>([
  'navigate',
  'click',
  'typeText',
  'pressKey',
  'scroll',
  'wait',
  'pasteText',
]);

export function isBrowserActionKind(kind: string): kind is BrowserActionKind {
  return BROWSER_ACTION_KIND_SET.has(kind);
}

export function isReadOnlyActionKind(kind: BrowserActionKind): boolean {
  return READ_ONLY_KINDS.has(kind);
}

export function defaultSideEffectClassForKind(kind: BrowserActionKind): SideEffectClass {
  if (READ_ONLY_KINDS.has(kind)) {
    return 'read_only';
  }
  return 'local_input';
}

function normalizeForHash(value: unknown): unknown {
  if (value === undefined) {
    return undefined;
  }
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (Array.isArray(value)) {
    return value.map((item) => normalizeForHash(item) ?? null);
  }
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entryValue]) => entryValue !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entryValue]) => [key, normalizeForHash(entryValue)]),
    );
  }
  return String(value);
}

export function canonicalizeForHash(value: unknown): string {
  return JSON.stringify(normalizeForHash(value));
}


const SHA256_K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

function rightRotate(value: number, bits: number): number {
  return (value >>> bits) | (value << (32 - bits));
}

function sha256Hex(input: string): string {
  const bytes = Array.from(new TextEncoder().encode(input));
  const bitLength = bytes.length * 8;
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) {
    bytes.push(0);
  }
  const high = Math.floor(bitLength / 0x1_0000_0000);
  const low = bitLength >>> 0;
  for (const word of [high, low]) {
    bytes.push((word >>> 24) & 0xff, (word >>> 16) & 0xff, (word >>> 8) & 0xff, word & 0xff);
  }

  const hash = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  const schedule = new Array<number>(64).fill(0);

  for (let offset = 0; offset < bytes.length; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      const position = offset + index * 4;
      schedule[index] =
        ((bytes[position] << 24) | (bytes[position + 1] << 16) | (bytes[position + 2] << 8) | bytes[position + 3]) >>> 0;
    }
    for (let index = 16; index < 64; index += 1) {
      const s0 = rightRotate(schedule[index - 15], 7) ^ rightRotate(schedule[index - 15], 18) ^ (schedule[index - 15] >>> 3);
      const s1 = rightRotate(schedule[index - 2], 17) ^ rightRotate(schedule[index - 2], 19) ^ (schedule[index - 2] >>> 10);
      schedule[index] = (schedule[index - 16] + s0 + schedule[index - 7] + s1) >>> 0;
    }

    let [a, b, c, d, e, f, g, h] = hash;
    for (let index = 0; index < 64; index += 1) {
      const s1 = rightRotate(e, 6) ^ rightRotate(e, 11) ^ rightRotate(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + s1 + ch + SHA256_K[index] + schedule[index]) >>> 0;
      const s0 = rightRotate(a, 2) ^ rightRotate(a, 13) ^ rightRotate(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + maj) >>> 0;

      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    hash[0] = (hash[0] + a) >>> 0;
    hash[1] = (hash[1] + b) >>> 0;
    hash[2] = (hash[2] + c) >>> 0;
    hash[3] = (hash[3] + d) >>> 0;
    hash[4] = (hash[4] + e) >>> 0;
    hash[5] = (hash[5] + f) >>> 0;
    hash[6] = (hash[6] + g) >>> 0;
    hash[7] = (hash[7] + h) >>> 0;
  }

  return hash.map((word) => word.toString(16).padStart(8, '0')).join('');
}

export function canonicalPayloadHash(value: unknown): string {
  return sha256Hex(canonicalizeForHash(value));
}


function validateRemoteFacingPayload(value: unknown): BrowserActionValidation {
  if (typeof value === 'string') {
    return validateRemoteFacingCopy(value);
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const validation = validateRemoteFacingPayload(item);
      if (!validation.ok) {
        return validation;
      }
    }
    return { ok: true };
  }

  if (value && typeof value === 'object') {
    for (const entryValue of Object.values(value as Record<string, unknown>)) {
      const validation = validateRemoteFacingPayload(entryValue);
      if (!validation.ok) {
        return validation;
      }
    }
  }

  return { ok: true };
}

function isRemoteMutationSideEffect(sideEffectClass: SideEffectClass): boolean {
  return sideEffectClass === 'remote_mutation_candidate' || sideEffectClass === 'approved_remote_mutation';
}

export function validateBrowserAction(action: BrowserAction, now: Date = new Date()): BrowserActionValidation {
  const runtimeKind = String(action.kind);
  if (!isBrowserActionKind(runtimeKind)) {
    return { ok: false, reason: `Unsupported browser action kind: ${runtimeKind}` };
  }

  if (!READ_ONLY_KINDS.has(runtimeKind) && !LOCAL_INPUT_KINDS.has(runtimeKind)) {
    return { ok: false, reason: `Unsupported browser action kind: ${runtimeKind}` };
  }

  if (action.target.runId !== action.runId) {
    return { ok: false, reason: 'Bound target runId does not match action runId.' };
  }

  if (!isRemoteMutationSideEffect(action.sideEffectClass)) {
    return { ok: true };
  }

  const copyValidation = validateRemoteFacingPayload(action.params);
  if (!copyValidation.ok) {
    return copyValidation;
  }

  const { approvalToken } = action;
  if (!approvalToken) {
    return { ok: false, reason: 'Remote mutation candidate requires an approval token.' };
  }

  if (Date.parse(approvalToken.expiresAt) <= now.getTime()) {
    return { ok: false, reason: 'Approval token expired.' };
  }

  if (approvalToken.runId !== action.runId) {
    return { ok: false, reason: 'Approval token runId does not match action runId.' };
  }

  if (approvalToken.targetId !== action.target.targetId) {
    return { ok: false, reason: 'Approval token targetId does not match bound target.' };
  }

  if (approvalToken.targetOrigin !== action.target.pageOrigin) {
    return { ok: false, reason: 'Approval token origin does not match bound target origin.' };
  }

  const actionPayloadHash = action.params.payloadHash;
  if (typeof actionPayloadHash === 'string' && approvalToken.payloadHash !== actionPayloadHash) {
    return { ok: false, reason: 'Approval token payload hash does not match action payload hash.' };
  }

  return { ok: true };
}
