import { z } from "zod";

const SemanticRefSchema = z.string().regex(/^(?:f\d+)?e\d+$/);
const FillOperationSchema = z
  .object({
    kind: z.literal("fill"),
    ref: SemanticRefSchema,
    text: z.string().max(8_000),
  })
  .strict();
const CheckOperationSchema = z
  .object({
    kind: z.literal("check"),
    ref: SemanticRefSchema,
    checked: z.boolean(),
  })
  .strict();
const SelectOperationSchema = z
  .object({
    kind: z.literal("select"),
    ref: SemanticRefSchema,
    labels: z.array(z.string().min(1).max(500)).min(1).max(12),
  })
  .strict();

export const EmptyHandInputSchema = z.object({}).strict();
export const BrowserStartInputSchema = z.object({ url: z.string().url().optional() }).strict();
export const SemanticFollowInputSchema = z
  .object({
    observationId: z.string().regex(/^obs-\d+$/),
    ref: SemanticRefSchema,
  })
  .strict();
export const SemanticDownloadInputSchema = z
  .object({
    observationId: z.string().regex(/^obs-\d+$/),
    ref: SemanticRefSchema,
  })
  .strict();
export const OwnedArtifactReadInputSchema = z
  .object({
    artifactId: z.string().trim().min(1).max(200).optional(),
    offset: z.number().int().min(0).max(1_000_000).default(0),
    maxChars: z.number().int().min(1_000).max(50_000).default(20_000),
  })
  .strict();
export const OwnedArtifactListInputSchema = z
  .object({
    cursor: z.string().trim().min(1).max(2_000).nullable().optional(),
    limit: z.number().int().min(1).max(50).default(20),
  })
  .strict();
export const ResearchEvidenceInputSchema = z
  .object({
    category: z.string().trim().min(1).max(100),
    artifactIds: z.array(z.string().trim().min(1).max(200)).min(1).max(50),
    summary: z.string().trim().min(1).max(2_000),
  })
  .strict();
export const SemanticPrepareInputSchema = z
  .object({
    observationId: z.string().regex(/^obs-\d+$/),
    operations: z
      .array(z.discriminatedUnion("kind", [FillOperationSchema, CheckOperationSchema, SelectOperationSchema]))
      .min(1)
      .max(12),
  })
  .strict();
export const RememberEventInputSchema = z
  .object({
    observationId: z.string().regex(/^obs-\d+$/),
    platform: z.enum(["luma", "partiful"]),
    world: z
      .object({
        name: z.string().trim().min(1).max(200),
        lane: z.enum(["topical", "social"]),
      })
      .strict(),
    gathering: z
      .object({
        name: z.string().trim().min(1).max(200),
        startsAt: z.string().datetime({ offset: true }),
      })
      .strict(),
  })
  .strict();

export type SemanticFollowInput = z.infer<typeof SemanticFollowInputSchema>;
export type SemanticDownloadInput = z.infer<typeof SemanticDownloadInputSchema>;
export type OwnedArtifactReadInput = z.infer<typeof OwnedArtifactReadInputSchema>;
export type OwnedArtifactListInput = z.infer<typeof OwnedArtifactListInputSchema>;
export type ResearchEvidenceInput = z.infer<typeof ResearchEvidenceInputSchema>;
export type SemanticPrepareInput = z.infer<typeof SemanticPrepareInputSchema>;
export type RememberEventInput = z.infer<typeof RememberEventInputSchema>;

export function semanticFollowTrace(input: unknown): Record<string, unknown> {
  return SemanticFollowInputSchema.parse(input);
}

export function semanticDownloadTrace(input: unknown): Record<string, unknown> {
  return SemanticDownloadInputSchema.parse(input);
}

export function semanticPrepareTrace(input: unknown): Record<string, unknown> {
  const parsed = SemanticPrepareInputSchema.parse(input);
  return {
    observationId: parsed.observationId,
    operations: parsed.operations.map((operation) => ({
      kind: operation.kind,
      ref: operation.ref,
      ...(operation.kind === "fill" ? { textLength: operation.text.length } : {}),
      ...(operation.kind === "select" ? { optionCount: operation.labels.length } : {}),
    })),
  };
}
