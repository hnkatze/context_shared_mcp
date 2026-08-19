import * as z from "zod/v4";

import { sourceRefSchema } from "../refs.js";

/**
 * Accepts a date or a full timestamp. Validated here rather than left to
 * Postgres so a malformed value comes back as a readable refusal instead of a
 * cast error from three layers down.
 */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}([T ][\d:.+-]*Z?)?$/;

export const testCaseSchema = z.object({
  scenario: z.string().min(1).describe("What a tester does, in one line"),
  expected: z.string().min(1).describe("What must happen for the change to be correct"),
});

export const publishChangeInputSchema = z.object({
  project: z
    .string()
    .min(1)
    .describe(
      "Project this change belongs to, written however you say it. It is created " +
        "on first use; a near-miss of an existing project is refused instead.",
    ),
  module: z.string().min(1).describe("Feature or module that changed, e.g. checkout"),
  change_key: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{1,62}$/)
    .describe(
      "Stable kebab-case slug for this change. Republishing it corrects the note; " +
        "a later change to the same module is a new key, not an edit of this one.",
    ),
  title: z.string().min(1).describe("One line: what happened"),
  what_changed: z
    .string()
    .min(1)
    .describe("The delta in prose — endpoints, fields, behaviour, defaults"),
  why: z.string().min(1).describe("The reason the change was made"),
  impact: z
    .string()
    .min(1)
    .optional()
    .describe("Who this breaks and how. Omit when it breaks nobody"),
  do_this: z
    .array(z.string().min(1))
    .default([])
    .describe("What a consumer has to do now, one action per entry"),
  do_not: z
    .array(z.string().min(1))
    .default([])
    .describe(
      "What a consumer must stop doing, or would reasonably assume and get wrong. " +
        "The half a diff never tells you.",
    ),
  test_cases: z
    .array(testCaseSchema)
    .default([])
    .describe("How a reader proves the change works on their side"),
  source_refs: z
    .array(sourceRefSchema)
    .min(1)
    .describe(
      "At least one commit, PR, endpoint or file. This is the gate: a change note " +
        "with nothing verifiable behind it cannot be told apart from a rumour.",
    ),
  supersedes_cards: z
    .array(z.string().min(1))
    .default([])
    .describe("card_keys this change made stale, so a reader knows not to trust them"),
  tags: z.array(z.string().min(1)).default([]),
  author: z.string().min(1),
  occurred_at: z
    .string()
    .regex(ISO_DATE)
    .optional()
    .describe(
      "When the change landed, if that is not today. Defaults to now on a new note, " +
        "and is left untouched when an existing note is corrected.",
    ),
  create_project: z
    .boolean()
    .default(false)
    .describe(
      "Only after a refusal: confirms the new project is meant to sit beside the " +
        "similar one already on the board, rather than being a misspelling of it.",
    ),
});

export const recentChangesInputSchema = z.object({
  project: z.string().min(1).optional().describe("Omit to sweep every project in the org"),
  module: z.string().min(1).optional(),
  since: z
    .string()
    .regex(ISO_DATE)
    .optional()
    .describe("Only changes that happened on or after this date, e.g. 2026-08-01"),
  limit: z.number().int().min(1).max(50).default(10),
});

export type PublishChangeInput = z.infer<typeof publishChangeInputSchema>;
export type RecentChangesInput = z.infer<typeof recentChangesInputSchema>;
