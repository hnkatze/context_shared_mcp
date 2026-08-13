import * as z from "zod/v4";

export const decisionSchema = z.object({
  choice: z.string().min(1).describe("What was decided"),
  rejected: z.string().min(1).describe("The alternative that was turned down"),
  reason: z.string().min(1).describe("Why the alternative lost"),
});

export const sourceRefSchema = z.object({
  kind: z.enum(["commit", "pr", "endpoint", "file"]),
  ref: z.string().min(1).describe("Commit sha, PR url, route path, or file path"),
});

export const publishInputSchema = z.object({
  project: z.string().min(1).describe("Project slug this card belongs to"),
  module: z.string().min(1).describe("Feature or module name, e.g. checkout"),
  card_key: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{1,62}$/)
    .describe("Stable kebab-case slug for this fact. Republishing it updates the card"),
  summary: z.string().min(1).describe("One line stating the fact"),
  why_not_obvious: z
    .string()
    .min(40)
    .describe(
      "What a reader cannot learn from the code or the OpenAPI spec. If this can " +
        "only restate the signature, there is no card worth publishing.",
    ),
  decisions: z.array(decisionSchema).default([]),
  gotchas: z.array(z.string().min(1)).default([]),
  consumer_notes: z.array(z.string().min(1)).default([]),
  source_refs: z
    .array(sourceRefSchema)
    .default([])
    .describe("Verifiable anchors, so a card written from a stale session can be checked"),
  tags: z.array(z.string().min(1)).default([]),
  author: z.string().min(1),
});

export const searchInputSchema = z.object({
  query: z.string().min(1).optional().describe("Free text; omit to browse by filter alone"),
  project: z.string().min(1).optional(),
  module: z.string().min(1).optional(),
  tags: z.array(z.string().min(1)).optional().describe("Matches a card carrying any of these"),
  limit: z.number().int().min(1).max(50).default(10),
});

export type PublishInput = z.infer<typeof publishInputSchema>;
export type SearchInput = z.infer<typeof searchInputSchema>;
