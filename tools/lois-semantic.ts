import {
  SemanticDownloadInputSchema,
  SemanticFollowInputSchema,
  SemanticPrepareInputSchema,
  type SemanticDownloadInput,
  type SemanticFollowInput,
  type SemanticPrepareInput,
} from "../packages/lois/hand-schemas.js";

export {
  SemanticDownloadInputSchema,
  SemanticFollowInputSchema,
  SemanticPrepareInputSchema,
} from "../packages/lois/hand-schemas.js";
export type { SemanticDownloadInput, SemanticFollowInput, SemanticPrepareInput } from "../packages/lois/hand-schemas.js";

const SENSITIVE =
  /password|passcode|one[- ]?time|verification|\botp\b|\b2fa\b|\bmfa\b|\bcvv\b|security code|secret|token|authorization|bearer|cookie|session|api[ -]?key|access token|refresh token/i;
const MAX_SNAPSHOT_CHARS = 7_000;
const STRUCTURAL_ONLY =
  /^\s*-\s+(?:generic|separator|contentinfo|navigation|alert)(?:\s+\[[^\]]+\])*\s*:?\s*$/;
const ANONYMOUS_NUMBER =
  /^\s*-\s+generic(?:\s+\[[^\]]+\])*\s*:\s*"?\d+"?\s*$/;
const UNAVAILABLE_URL = /^\s*-\s*\/url:\s*unavailable\s*$/;

type SemanticOperation = SemanticPrepareInput["operations"][number];

export interface SemanticControlMetadata {
  tag: string;
  type: string;
  role: string;
  readOnly: boolean;
  multiple: boolean;
  hidden: boolean;
  href?: string | null;
  formAssociated?: boolean;
  /** Labels and attributes that describe the control; never its current value. */
  descriptor: string;
  options: { label: string; disabled: boolean }[];
}

export interface SemanticLocator {
  count(): Promise<number>;
  isVisible(): Promise<boolean>;
  isEnabled(): Promise<boolean>;
  inspect(): Promise<SemanticControlMetadata>;
  fill(text: string): Promise<void>;
  check(checked: boolean): Promise<void>;
  select(labels: string[]): Promise<void>;
  /** Activate one native view control while the host blocks network writes. */
  activate(): Promise<{ blockedWrite: boolean; blockedCrossSiteNavigation: boolean }>;
  /** Activate this exact observed control and save only the download it emits. */
  download(destinationDir: string): Promise<SemanticDownloadActivation>;
}

export type SemanticDownloadActivation =
  | { ok: true; filename: string; path: string; bytes: number }
  | { ok: false; reason: "no-download" | "failed" };

export interface SemanticPage {
  url(): string;
  title(): Promise<string>;
  ariaSnapshot(): Promise<string>;
  /** Resolve one ref from this page's most recent AI ARIA snapshot. */
  locator(ref: string): SemanticLocator;
  /** Navigate directly; following a link never dispatches its click handlers. */
  navigate(url: string): Promise<void>;
}

export interface SemanticFacts {
  /** Object identity for the exact live Playwright page. */
  pageToken: object;
  rawUrl: string;
  navigationEpoch: number;
  controlEpoch: number;
}

export interface SemanticResult {
  ok: boolean;
  note: string;
}

export interface SemanticEvidenceResult extends SemanticResult {
  /** Query strings and fragments are never allowed to become vault provenance. */
  url?: string;
}

export interface SemanticObservationSnapshot {
  observationId: string;
  /** Already stripped of query strings and fragments. */
  sourceUrl: string;
  /** The exact bounded, scrubbed text returned to the model. */
  text: string;
}

export interface SemanticSessionOptions {
  /** Digits prepended to the per-session sequence; omitted in deterministic unit sessions. */
  observationIdPrefix?: string;
  /** Host ownership token sampled across the asynchronous page snapshot and capture. */
  observationOwner?: () => string | null;
  onObservation?: (snapshot: SemanticObservationSnapshot) => void | Promise<void>;
}

interface Observation {
  id: string;
  facts: SemanticFacts;
  refs: Set<string>;
}

function sameFacts(left: SemanticFacts | null, right: SemanticFacts): boolean {
  return Boolean(
    left &&
      left.pageToken === right.pageToken &&
      left.rawUrl === right.rawUrl &&
      left.navigationEpoch === right.navigationEpoch &&
      left.controlEpoch === right.controlEpoch,
  );
}

function publicUrl(raw: string): string {
  try {
    const url = new URL(raw);
    return `${url.origin}${url.pathname}`;
  } catch {
    return "unavailable";
  }
}

function scrubTitle(title: string): string {
  if (SENSITIVE.test(title)) return "";
  return title.split(/[?#]/, 1)[0].replace(/[\r\n]+/g, " ").trim().slice(0, 300);
}

function scrubUrlProperty(line: string): string {
  const match = line.match(/^(\s*-\s*\/url:\s*)(\S+)/);
  if (match) return `${match[1]}${publicUrl(match[2])}`;
  return line.replace(/https?:\/\/[^\s"'<>]+/g, (url) => publicUrl(url));
}

function compactIndent(line: string): string {
  const content = line.trimStart();
  return `${" ".repeat(Math.min(6, line.length - content.length))}${content}`;
}

function scrubSnapshot(raw: string): {
  text: string;
  refs: Set<string>;
  keptLines: number;
  signalLines: number;
  truncated: boolean;
} {
  const signal: string[] = [];
  for (const sourceLine of raw.split(/\r?\n/)) {
    if (SENSITIVE.test(sourceLine)) continue;
    let line = scrubUrlProperty(sourceLine);
    if (/\b(?:textbox|searchbox|combobox|spinbutton)\b/i.test(line)) {
      line = line.replace(/(\[ref=(?:f\d+)?e\d+\])\s*:.*/, "$1");
    }
    if (STRUCTURAL_ONLY.test(line) || ANONYMOUS_NUMBER.test(line) || UNAVAILABLE_URL.test(line)) {
      continue;
    }
    signal.push(compactIndent(line));
  }

  const kept: string[] = [];
  let length = 0;
  for (const line of signal) {
    const addition = line.length + (kept.length > 0 ? 1 : 0);
    if (length + addition > MAX_SNAPSHOT_CHARS) break;
    kept.push(line);
    length += addition;
  }

  const text = kept.join("\n");
  const refs = new Set<string>();
  for (const match of text.matchAll(/\[ref=((?:f\d+)?e\d+)\]/g)) refs.add(match[1]);
  return {
    text,
    refs,
    keptLines: kept.length,
    signalLines: signal.length,
    truncated: kept.length < signal.length,
  };
}

function unsafeControl(metadata: SemanticControlMetadata): boolean {
  const tag = metadata.tag.toLowerCase();
  const type = metadata.type.toLowerCase();
  return (
    metadata.hidden ||
    metadata.readOnly ||
    type === "hidden" ||
    type === "file" ||
    type === "password" ||
    tag === "button" ||
    SENSITIVE.test(metadata.descriptor)
  );
}

function operationRefusal(operation: SemanticOperation, metadata: SemanticControlMetadata): string | null {
  if (unsafeControl(metadata)) return "The requested control is sensitive or unsafe to prepare.";
  const tag = metadata.tag.toLowerCase();
  const type = metadata.type.toLowerCase();

  if (operation.kind === "fill") {
    const safeInput = tag === "input" && ["", "text", "email", "search", "tel", "url"].includes(type);
    if (tag !== "textarea" && !safeInput) {
      return "The requested ref is not a safe text control.";
    }
    return null;
  }

  if (operation.kind === "check") {
    if (!(tag === "input" && type === "checkbox")) {
      return "The requested ref is not a checkbox.";
    }
    return null;
  }

  if (tag !== "select") return "The requested ref is not a native select.";
  if (!metadata.multiple && operation.labels.length > 1) {
    return "The requested select accepts only one option.";
  }
  for (const label of operation.labels) {
    const matches = metadata.options.filter((option) => option.label === label);
    if (matches.length !== 1 || matches[0].disabled) {
      return "A requested visible option is missing, ambiguous, or disabled.";
    }
  }
  return null;
}

export function createSemanticSession(options: SemanticSessionOptions = {}) {
  const idPrefix = options.observationIdPrefix ?? "";
  if (!/^\d*$/.test(idPrefix)) throw new Error("Semantic observation id prefix must contain only digits");
  let sequence = 0;
  let latest: Observation | null = null;

  return {
    invalidate(): void {
      latest = null;
    },

    async observe(
      page: SemanticPage,
      facts: SemanticFacts,
      currentFacts: () => Promise<SemanticFacts | null>,
    ): Promise<SemanticResult> {
      latest = null;
      const ownerBefore = options.observationOwner?.();
      try {
        const before = await currentFacts();
        if (!sameFacts(before, facts) || page.url() !== facts.rawUrl) {
          return { ok: false, note: "The page changed before it could be observed. Observe it again." };
        }
        const [title, snapshot] = await Promise.all([page.title(), page.ariaSnapshot()]);
        const after = await currentFacts();
        if (!sameFacts(after, facts) || page.url() !== facts.rawUrl) {
          return { ok: false, note: "The page changed while it was being observed. Observe it again." };
        }
        const scrubbed = scrubSnapshot(snapshot);
        const id = `obs-${idPrefix}${++sequence}`;
        const note = [
            `Observation ${id}`,
            `Page: ${scrubTitle(title) || "Untitled"}`,
            `URL: ${publicUrl(facts.rawUrl)}`,
            `Semantic view: ${scrubbed.keptLines}/${scrubbed.signalLines} signal lines${scrubbed.truncated ? " (bounded)" : ""}`,
            scrubbed.text || "No safe semantic controls were visible.",
          ].join("\n");
        if (options.onObservation) {
          if (
            !Object.is(ownerBefore, options.observationOwner?.())
          ) {
            return { ok: false, note: "Could not retain the browser observation safely. Observe it again." };
          }
          try {
            await options.onObservation({
              observationId: id,
              sourceUrl: publicUrl(facts.rawUrl),
              text: note,
            });
          } catch {
            return { ok: false, note: "Could not retain the browser observation safely. Observe it again." };
          }
          if (!Object.is(ownerBefore, options.observationOwner?.())) {
            return { ok: false, note: "Could not retain the browser observation safely. Observe it again." };
          }
        }
        latest = { id, facts: { ...facts }, refs: scrubbed.refs };
        return { ok: true, note };
      } catch {
        return {
          ok: false,
          note: "Could not observe the page safely. Observe it again.",
        };
      }
    },

    async evidence(
      page: SemanticPage,
      facts: SemanticFacts,
      observationId: string,
      currentFacts: () => Promise<SemanticFacts | null>,
    ): Promise<SemanticEvidenceResult> {
      const observation = latest;
      if (
        !observation ||
        observationId !== observation.id ||
        !sameFacts(facts, observation.facts) ||
        !sameFacts(await currentFacts(), observation.facts) ||
        page.url() !== observation.facts.rawUrl
      ) {
        return { ok: false, note: "That browser observation is stale. Observe the page again." };
      }
      return {
        ok: true,
        note: "The current browser observation still matches the live page.",
        url: publicUrl(observation.facts.rawUrl),
      };
    },

    async download(
      page: SemanticPage,
      facts: SemanticFacts,
      input: SemanticDownloadInput,
      currentFacts: () => Promise<SemanticFacts | null>,
      destinationDir: string,
    ): Promise<SemanticResult> {
      const observation = latest;
      latest = null;
      const parsed = SemanticDownloadInputSchema.safeParse(input);
      if (!parsed.success) return { ok: false, note: "Invalid semantic download request." };
      if (
        !observation ||
        parsed.data.observationId !== observation.id ||
        !sameFacts(facts, observation.facts) ||
        !sameFacts(await currentFacts(), observation.facts) ||
        page.url() !== observation.facts.rawUrl
      ) {
        return { ok: false, note: "That browser observation is stale. Observe the page again." };
      }
      if (!observation.refs.has(parsed.data.ref)) {
        return { ok: false, note: "The requested ref was not issued by that observation." };
      }

      try {
        const locator = page.locator(parsed.data.ref);
        if ((await locator.count()) !== 1) {
          return { ok: false, note: "The requested ref no longer names one exact download control." };
        }
        if (!(await locator.isVisible()) || !(await locator.isEnabled())) {
          return { ok: false, note: "The requested download control is hidden or disabled." };
        }
        const metadata = await locator.inspect();
        const tag = metadata.tag.toLowerCase();
        const type = metadata.type.toLowerCase();
        if (!new Set(["a", "button"]).has(tag) || metadata.hidden) {
          return { ok: false, note: "The requested ref is not a native download control." };
        }
        if (tag === "button" && (metadata.formAssociated || type === "submit")) {
          return {
            ok: false,
            note: "Refused browser download: the observed control submits a form rather than standing alone.",
          };
        }
        if (
          !sameFacts(await currentFacts(), observation.facts) ||
          page.url() !== observation.facts.rawUrl
        ) {
          return { ok: false, note: "That browser observation is stale. Observe the page again." };
        }

        const activation = await locator.download(destinationDir);
        if (!activation.ok) {
          return activation.reason === "no-download"
            ? {
                ok: false,
                note: "That observed control did not start a download. Observe the page for a confirmation or error.",
              }
            : { ok: false, note: "The browser started a download but could not save it in Lois's workspace." };
        }
        return {
          ok: true,
          note: `Downloaded ${activation.filename} (${activation.bytes} bytes) to ${activation.path}.`,
        };
      } catch {
        return { ok: false, note: "Could not download from that observed control. Observe the page again." };
      }
    },

    async prepare(
      page: SemanticPage,
      facts: SemanticFacts,
      input: unknown,
      currentFacts: () => Promise<SemanticFacts | null>,
    ): Promise<SemanticResult> {
      const observation = latest;
      latest = null;
      const parsed = SemanticPrepareInputSchema.safeParse(input);
      if (!parsed.success) return { ok: false, note: "Invalid semantic preparation request." };
      if (
        !observation ||
        parsed.data.observationId !== observation.id ||
        !sameFacts(facts, observation.facts) ||
        !sameFacts(await currentFacts(), observation.facts) ||
        page.url() !== observation.facts.rawUrl
      ) {
        return { ok: false, note: "That browser observation is stale. Observe the page again." };
      }

      const refs = parsed.data.operations.map((operation) => operation.ref);
      if (new Set(refs).size !== refs.length) {
        return { ok: false, note: "Each observed ref may be prepared only once per batch." };
      }

      const prepared: { operation: SemanticOperation; locator: SemanticLocator }[] = [];
      try {
        for (const operation of parsed.data.operations) {
          if (!observation.refs.has(operation.ref)) {
            return { ok: false, note: "A requested ref was not issued by that observation." };
          }
          const locator = page.locator(operation.ref);
          if ((await locator.count()) !== 1) {
            return { ok: false, note: "A requested ref no longer names one exact control." };
          }
          if (!(await locator.isVisible()) || !(await locator.isEnabled())) {
            return { ok: false, note: "A requested control is hidden or disabled." };
          }
          const refusal = operationRefusal(operation, await locator.inspect());
          if (refusal) return { ok: false, note: refusal };
          prepared.push({ operation, locator });
        }

        let completed = 0;
        for (const item of prepared) {
          if (!sameFacts(await currentFacts(), observation.facts) || page.url() !== observation.facts.rawUrl) {
            return {
              ok: false,
              note: completed
                ? `The page changed after ${completed} control(s) were prepared. Nothing was submitted.`
                : "That browser observation is stale. Observe the page again.",
            };
          }
          if (item.operation.kind === "fill") await item.locator.fill(item.operation.text);
          else if (item.operation.kind === "check") await item.locator.check(item.operation.checked);
          else await item.locator.select(item.operation.labels);
          completed += 1;
        }
        if (!sameFacts(await currentFacts(), observation.facts) || page.url() !== observation.facts.rawUrl) {
          return {
            ok: false,
            note: `The page changed after ${completed} control(s) were prepared. Nothing was submitted.`,
          };
        }
        return {
          ok: true,
          note: `Prepared ${completed} control${completed === 1 ? "" : "s"}. Nothing was submitted.`,
        };
      } catch {
        return {
          ok: false,
          note: "Browser preparation failed. Nothing was submitted; observe the page again.",
        };
      }
    },

    async follow(
      page: SemanticPage,
      facts: SemanticFacts,
      input: SemanticFollowInput,
      currentFacts: () => Promise<SemanticFacts | null>,
    ): Promise<SemanticResult> {
      const observation = latest;
      latest = null;
      const parsed = SemanticFollowInputSchema.safeParse(input);
      if (!parsed.success) return { ok: false, note: "Invalid semantic follow request." };
      if (
        !observation ||
        parsed.data.observationId !== observation.id ||
        !sameFacts(facts, observation.facts) ||
        !sameFacts(await currentFacts(), observation.facts) ||
        page.url() !== observation.facts.rawUrl
      ) {
        return { ok: false, note: "That browser observation is stale. Observe the page again." };
      }
      if (!observation.refs.has(parsed.data.ref)) {
        return { ok: false, note: "The requested ref was not issued by that observation." };
      }

      try {
        const locator = page.locator(parsed.data.ref);
        if ((await locator.count()) !== 1) {
          return { ok: false, note: "The requested ref no longer names one exact link." };
        }
        if (!(await locator.isVisible()) || !(await locator.isEnabled())) {
          return { ok: false, note: "The requested link is hidden or disabled." };
        }
        const metadata = await locator.inspect();
        const tag = metadata.tag.toLowerCase();
        const source = new URL(observation.facts.rawUrl);
        if (tag === "a" && metadata.href) {
          const target = new URL(metadata.href, source);
          if (
            (target.protocol !== "http:" && target.protocol !== "https:") ||
            target.origin !== source.origin
          ) {
            return {
              ok: false,
              note: "That observed link leaves the current site; open it explicitly instead.",
            };
          }
          if (
            !sameFacts(await currentFacts(), observation.facts) ||
            page.url() !== observation.facts.rawUrl
          ) {
            return { ok: false, note: "That browser observation is stale. Observe the page again." };
          }
          await page.navigate(target.href);
          return { ok: true, note: `Followed the observed link to ${publicUrl(page.url())}.` };
        }

        if (tag !== "button" || (metadata.formAssociated && metadata.type.toLowerCase() !== "button")) {
          return { ok: false, note: "The requested ref is not a safe native view control." };
        }
        if (
          !sameFacts(await currentFacts(), observation.facts) ||
          page.url() !== observation.facts.rawUrl
        ) {
          return { ok: false, note: "That browser observation is stale. Observe the page again." };
        }
        const activation = await locator.activate();
        if (activation.blockedCrossSiteNavigation) {
          return {
            ok: false,
            note: "The observed control tried to leave the current site, so the browser fence stopped it.",
          };
        }
        const after = await currentFacts();
        const viewChanged = Boolean(
          after &&
            (!sameFacts(after, observation.facts) || page.url() !== observation.facts.rawUrl),
        );
        if (activation.blockedWrite && !viewChanged) {
          return {
            ok: false,
            note: "The observed control tried to make a write request, so the browser fence stopped it.",
          };
        }
        return {
          ok: true,
          note: `Activated the observed view control behind the read-only browser fence.${activation.blockedWrite ? " An incidental write request was stopped." : ""}`,
        };
      } catch {
        return { ok: false, note: "Could not follow that observed link. Observe the page again." };
      }
    },
  };
}
