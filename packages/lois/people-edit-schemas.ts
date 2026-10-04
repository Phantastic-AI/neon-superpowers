import { z } from "zod";

const id = z.string().trim().min(1);
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const scope = { contextId: id, viewId: id };
const command = { ...scope, requestId: id };

export const ReadPeopleInputSchema = z.object({
  ...scope,
  offset: z.number().int().nonnegative().default(0),
  limit: z.number().int().min(1).max(100).default(50),
  includeEvidence: z.boolean().default(false),
  /** Read an immutable submission rather than the roster. */
  waveId: id.optional(),
});
export const OrderPeopleInputSchema = z.object({ ...command, personIds: z.array(id).min(1), baseRevision: revision, waveId: id.optional() });
export const ReplyPeopleInputSchema = z.object({
  ...command, waveId: id, noteId: id, personId: id, replyTo: id,
  text: z.string().min(1).refine((text) => Boolean(text.trim()), "Reply cannot be blank"),
  baseRevision: revision,
});
export const FinishPeopleNotesInputSchema = z.object({ ...command, waveId: id, status: z.enum(["completed", "failed"]) });
