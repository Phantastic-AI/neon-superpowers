import { isDeepStrictEqual } from "node:util";
import type { NewEntry } from "./append.js";
import type { Vault } from "./store.js";

function reject(reason: string): never {
  throw new Error(`appendEntry: secretaryClaim ${reason}`);
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) reject(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !value.trim()) reject(`${label} must be a non-empty string`);
}

function strings(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || !value.length) reject(`${label} must be a non-empty array`);
  for (const item of value) text(item, label);
  if (new Set(value).size !== value.length) reject(`${label} must contain unique values`);
  return value as string[];
}

function stringList(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || !value.length) reject(`${label} must be a non-empty array`);
  for (const item of value) text(item, label);
  return value as string[];
}

function validCalendarDate(year: number, month: number, day: number): boolean {
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1];
}

export function isSecretaryIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/);
  if (!match) return false;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, , zone] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  if (!validCalendarDate(year, month, day)) return false;
  if (hour > 23 || minute > 59 || second > 59) return false;
  if (zone !== "Z") {
    const [offsetHour, offsetMinute] = zone.slice(1).split(":").map(Number);
    if (offsetHour > 23 || offsetMinute > 59) return false;
  }
  return !Number.isNaN(Date.parse(value));
}

export function isSecretaryIsoDateOrTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const date = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (date) return validCalendarDate(Number(date[1]), Number(date[2]), Number(date[3]));
  return isSecretaryIsoTimestamp(value);
}

function nullableDate(value: unknown, label: string): void {
  if (value !== null && !isSecretaryIsoDateOrTimestamp(value)) {
    reject(`${label} must be null or a proper ISO date or timestamp`);
  }
}

function unverifiedIdentity(vault: Vault, context: string, personId: string, identity: string, label: string): void {
  const person = vault.personById.get(personId);
  const anchors = person?.anchors.filter((anchor) => anchor.context === context && anchor.value === identity) ?? [];
  if (anchors.length !== 1 || anchors[0].verified !== false) {
    reject(`${label} must match exactly one unverified Person identity in this World`);
  }
}

export function validateSecretaryClaimEntry(vault: Vault, entry: NewEntry): void {
  if (!Object.hasOwn(entry.payload, "secretaryClaim")) return;
  if (entry.type !== "fact" || entry.subtype !== "lookup") reject("requires fact/lookup");
  if (entry.about !== undefined || entry.persons === undefined) reject("cannot name a Gathering and must name its Persons");
  if (entry.confidence !== "chatham") reject("must use the D-041 research default chatham");
  if (!isSecretaryIsoTimestamp(entry.at)) reject("entry.at must be a strict ISO timestamp");

  const claim = object(entry.payload.secretaryClaim, "payload");
  if (claim.schemaVersion !== 1) reject("schemaVersion must be 1");
  for (const key of ["extractionId", "modelId", "subject", "subjectName", "subjectPersonId", "predicate", "timeBasis"]) {
    text(claim[key], key);
  }
  if (claim.validatedAt !== null) reject("validatedAt must remain null until an actual verification operation exists");
  nullableDate(claim.validFrom, "validFrom");
  nullableDate(claim.validTo, "validTo");
  if (claim.validFrom && claim.validTo && Date.parse(claim.validFrom as string) > Date.parse(claim.validTo as string)) {
    reject("validFrom must not be after validTo");
  }
  if (entry.epistemics !== "stated" && entry.epistemics !== "inferred") reject("requires stated or inferred epistemics");

  const belief = object(claim.belief, "belief");
  if (!["low", "medium", "high", "unknown"].includes(belief.level as string)) reject("belief.level is invalid");
  text(belief.reason, "belief.reason");

  const objectValue = object(claim.object, "object");
  if (objectValue.kind !== "person" && objectValue.kind !== "text") reject("object.kind must be person or text");
  text(objectValue.value, "object.value");
  const expectedPersons = [claim.subjectPersonId as string];
  if (objectValue.kind === "person") {
    text(claim.objectPersonId, "objectPersonId");
    text(claim.objectName, "objectName");
    expectedPersons.push(claim.objectPersonId);
  } else if (claim.objectPersonId !== undefined || claim.objectName !== undefined) {
    reject("text objects cannot carry object Person fields");
  }
  if (!isDeepStrictEqual(entry.persons, expectedPersons)) reject("persons must match the claim subject and Person object");
  unverifiedIdentity(vault, entry.context, claim.subjectPersonId as string, claim.subject as string, "subject identity");
  if (objectValue.kind === "person") {
    unverifiedIdentity(vault, entry.context, claim.objectPersonId as string, objectValue.value as string, "object identity");
  }

  const evidenceIds = strings(claim.evidenceIds, "evidenceIds");
  const evidenceEntryIds = strings(claim.evidenceEntryIds, "evidenceEntryIds");
  const observed = stringList(claim.sourceObservedAt, "sourceObservedAt");
  if (evidenceIds.length !== evidenceEntryIds.length || evidenceIds.length !== observed.length) {
    reject("evidence ids, source entries, and observation times must align");
  }
  for (let index = 0; index < evidenceEntryIds.length; index++) {
    const sourceEntry = vault.entryById.get(evidenceEntryIds[index]);
    const source = sourceEntry?.payload.secretarySource as Record<string, unknown> | undefined;
    if (!sourceEntry || sourceEntry.context !== entry.context || sourceEntry.type !== "interaction" || !source) {
      reject(`evidenceEntryIds[${index}] must name a retained secretary source in this World`);
    }
    if (source.sourceId !== evidenceIds[index] || source.observedAt !== observed[index]) {
      reject(`evidenceEntryIds[${index}] does not match its source id and observed time`);
    }
  }
  if (entry.evidence !== evidenceEntryIds[0]) reject("entry evidence must be the first retained source entry");
  const expectedRefs = [...evidenceEntryIds, ...(entry.supersedes ? [entry.supersedes] : [])];
  if (!isDeepStrictEqual(entry.refs, expectedRefs)) reject("refs must name the retained sources and explicit supersession only");

  if (entry.supersedes !== undefined) {
    const previous = vault.entryById.get(entry.supersedes);
    const priorClaim = previous?.payload.secretaryClaim as Record<string, unknown> | undefined;
    if (!previous || previous.context !== entry.context || !priorClaim) reject("supersedes must name an existing secretary claim in this World");
    if (priorClaim.subject !== claim.subject || priorClaim.predicate !== claim.predicate) {
      reject("corrections must keep the same subject and predicate");
    }
  }
}
