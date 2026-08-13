import type { Card, Project } from "./repository.js";

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

export function formatCards(cards: readonly Card[]): string {
  if (cards.length === 0) {
    return "No cards matched. Try a broader query, or list_projects to see what exists.";
  }
  return cards.map(formatCard).join("\n\n---\n\n");
}

export function formatProjects(projects: readonly Project[]): string {
  if (projects.length === 0) return "This organization has no projects yet.";
  return projects
    .map((p) => `- \`${p.slug}\` — ${p.name} (${p.cardCount} cards)`)
    .join("\n");
}
