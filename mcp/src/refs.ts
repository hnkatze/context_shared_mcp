import * as z from "zod/v4";

/**
 * A verifiable anchor. Both entities on the board carry these, for different
 * reasons: on a card they let a claim written from a compacted session still be
 * checked, and on a change note they are the quality gate itself.
 */
export const sourceRefSchema = z.object({
  kind: z.enum(["commit", "pr", "endpoint", "file"]),
  ref: z.string().min(1).describe("Commit sha, PR url, route path, or file path"),
});

export type SourceRef = {
  readonly kind: string;
  readonly ref: string;
};
