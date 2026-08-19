import * as z from "zod/v4";

import { formatCard } from "./cards/format.js";
import type { Card } from "./cards/repository.js";
import { formatChange } from "./changes/format.js";
import type { ChangeNote } from "./changes/repository.js";

/**
 * One query shape for both entities. `limit` applies per kind rather than to
 * the merged result: a reader who asks for ten and gets ten changes and no
 * cards has been told less than they asked for, and which half gets truncated
 * would depend on nothing they can see.
 */
export const searchInputSchema = z.object({
  query: z.string().min(1).optional().describe("Free text; omit to browse by filter alone"),
  project: z.string().min(1).optional(),
  module: z.string().min(1).optional(),
  tags: z.array(z.string().min(1)).optional().describe("Matches an entry carrying any of these"),
  kind: z
    .enum(["card", "change", "both"])
    .default("both")
    .describe(
      "card: durable facts about how a module behaves. change: dated notes about " +
        "what someone changed and what you must do about it. Default sweeps both.",
    ),
  limit: z.number().int().min(1).max(50).default(10),
});

export type SearchInput = z.infer<typeof searchInputSchema>;

const NOTHING_MATCHED =
  "Nothing on the board matched. Try a broader query, or list_projects to see what exists.";

/**
 * Changes lead. When a card and a change note disagree, the change is the more
 * recent account by construction, and a reader who stops after the first entry
 * should stop on that one rather than on the fact it just invalidated.
 */
export function formatResults(
  cards: readonly Card[],
  changes: readonly ChangeNote[],
): string {
  const blocks: string[] = [];

  if (changes.length > 0) {
    blocks.push(
      `# Changes (${changes.length})`,
      changes.map(formatChange).join("\n\n---\n\n"),
    );
  }
  if (cards.length > 0) {
    blocks.push(`# Cards (${cards.length})`, cards.map(formatCard).join("\n\n---\n\n"));
  }

  return blocks.length === 0 ? NOTHING_MATCHED : blocks.join("\n\n");
}
