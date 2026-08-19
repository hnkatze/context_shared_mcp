import * as z from "zod/v4";

import { sourceRefSchema } from "../refs.js";

export const decisionSchema = z.object({
  choice: z.string().min(1).describe("What was decided"),
  rejected: z.string().min(1).describe("The alternative that was turned down"),
  reason: z.string().min(1).describe("Why the alternative lost"),
});

export const publishInputSchema = z.object({
  project: z
    .string()
    .min(1)
    .describe(
      "Project this card belongs to, written however you say it. It is created " +
        "on first use; a near-miss of an existing project is refused instead.",
    ),
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
  create_project: z
    .boolean()
    .default(false)
    .describe(
      "Only after a refusal: confirms the new project is meant to sit beside the " +
        "similar one already on the board, rather than being a misspelling of it.",
    ),
});

export type PublishInput = z.infer<typeof publishInputSchema>;
