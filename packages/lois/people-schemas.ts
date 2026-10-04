import { z } from "zod";

const text = z.string().trim().min(1);
// Header spelling is a source reference, not customer prose. Preserve spaces.
const column = z.string().min(1);
const scope = {
  contextId: text.describe("Existing local World ID returned by worlds or remember_world. This is not a diver job ID, source account ID, or event ID."),
  viewId: text.describe("Stable local saved people-view ID to reuse, or a new stable ID chosen for this selected source view."),
};
const sourceIdentity = z.object({ platform: text, accountId: text, eventId: text });
const evidenceInput = z.union([z.object({ artifactId: text }), z.object({ observationId: text })]);
const sourceInput = sourceIdentity.extend({ name: text, date: text, url: z.string().url(), evidence: evidenceInput });
export type PeopleEvidenceInput = z.infer<typeof evidenceInput>;
const proof = z.array(evidenceInput).min(1);
const confidence = z.enum(["open", "chatham", "confided"]);
export const SavePeopleProspectInputSchema = z.object({
  ...scope, requestId: text, rowId: text, name: text,
  source: z.object({ platform: text, sourceId: text, label: text, accountId: text.optional(), url: z.string().url().optional() }),
  evidence: proof, confidence,
  anchors: z.array(z.object({
    kind: z.enum(["email", "phone", "linkedin"]), value: text,
    identity: z.object({ rationale: text, evidence: proof }).optional(),
  })).default([]),
  reason: z.object({ text, evidence: proof, confidence }),
});
export const SelectPeopleInputSchema = z.object({ ...scope, viewName: text, sources: z.array(sourceInput).min(1), discoveryComplete: z.boolean() });
export const ImportPeopleCsvInputSchema = z.object({
  ...scope, source: sourceIdentity, artifactId: text,
  columns: z.object({ rowId: column.optional(), name: z.array(column).min(1), email: column.optional(), phone: column.optional(), linkedin: column.optional(), rsvp: column.optional(), attendance: column.optional() }),
  identity: z.object({
    kind: z.enum(["email", "phone", "linkedin"]),
    rationale: text,
    evidence: z.array(evidenceInput).min(1),
  }).optional(),
  readState: z.enum(["partial", "read"]),
});
export const CreatePeopleWorldInputSchema = z.object({ name: text, lane: z.enum(["topical", "social"]), anchor: z.enum(["email", "phone", "linkedin"]), requestId: text });
