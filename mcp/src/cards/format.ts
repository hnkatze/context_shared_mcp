import type { Card } from "./repository.js";

function section(title: string, lines: readonly string[]): readonly string[] {
  if (lines.length === 0) return [];
  return [`**${title}**`, ...lines.map((line) => `- ${line}`), ""];
}

/**
 * Rendered for a reading agent rather than a browser: the why comes before the
 * detail, so a truncated read still carries the part that cannot be inferred.
 */
export function formatCard(card: Card): string {
  const lines: string[] = [
    `## ${card.summary}`,
    `\`${card.project}/${card.module}\` · key: \`${card.cardKey}\` · ${card.author} · updated ${card.updatedAt}`,
    "",
    "**Why this is not obvious**",
    card.whyNotObvious,
    "",
    ...section(
      "Decisions",
      card.decisions.map((d) => `${d.choice} (over: ${d.rejected}) — ${d.reason}`),
    ),
    ...section("Gotchas", card.gotchas),
    ...section("For the consumer", card.consumerNotes),
    ...section(
      "Sources",
      card.sourceRefs.map((r) => `${r.kind}: ${r.ref}`),
    ),
  ];
  if (card.tags.length > 0) lines.push(`tags: ${card.tags.join(", ")}`);
  return lines.join("\n").trimEnd();
}
