import type { ChangeNote } from "./repository.js";

function section(title: string, lines: readonly string[]): readonly string[] {
  if (lines.length === 0) return [];
  return [`**${title}**`, ...lines.map((line) => `- ${line}`), ""];
}

function prose(title: string, body: string | null): readonly string[] {
  if (body === null || body.trim() === "") return [];
  return [`**${title}**`, body, ""];
}

/**
 * Ordered the way the reader's questions actually arrive: what happened, why,
 * whether it touches me, what I do about it. `Do not` sits directly under
 * `Do` because the two are read as a pair and a truncated read that keeps only
 * the first half is worse than one that keeps neither.
 */
export function formatChange(change: ChangeNote): string {
  const lines: string[] = [
    `## ${change.title}`,
    `\`${change.project}/${change.module}\` · change: \`${change.changeKey}\` · ` +
      `${change.author} · happened ${change.occurredAt}`,
    "",
    ...prose("What changed", change.whatChanged),
    ...prose("Why", change.why),
    ...prose("Impact", change.impact),
    ...section("Do", change.doThis),
    ...section("Do not", change.doNot),
    ...section(
      "Test cases",
      change.testCases.map((t) => `${t.scenario} → ${t.expected}`),
    ),
    ...section(
      "Supersedes cards",
      change.supersedesCards.map((key) => `\`${key}\` — do not trust it for this module`),
    ),
    ...section(
      "Sources",
      change.sourceRefs.map((r) => `${r.kind}: ${r.ref}`),
    ),
  ];
  if (change.tags.length > 0) lines.push(`tags: ${change.tags.join(", ")}`);
  return lines.join("\n").trimEnd();
}

export function formatChanges(changes: readonly ChangeNote[]): string {
  if (changes.length === 0) {
    return "No change notes matched. Try a wider date range, or drop the project filter.";
  }
  return changes.map(formatChange).join("\n\n---\n\n");
}
