const MIN_LENGTH_FOR_TYPO = 5;
const MAX_TYPO_DISTANCE = 2;

/**
 * Names arrive as a human wrote them, so the slug is derived rather than
 * demanded. Diacritics fold into their base letter instead of being dropped.
 */
export function toSlug(name: string): string {
  return name
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 63)
    .replace(/^-+|-+$/g, "");
}

function skeleton(slug: string): string {
  return slug.replace(/[^a-z0-9]/g, "");
}

function editDistance(a: string, b: string): number {
  let previous: readonly number[] = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const current: number[] = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const left = current[j - 1];
      const above = previous[j];
      const diagonal = previous[j - 1];
      if (left === undefined || above === undefined || diagonal === undefined) {
        throw new Error("edit distance rows fell out of step");
      }
      const substitution = a[i - 1] === b[j - 1] ? diagonal : diagonal + 1;
      current.push(Math.min(left + 1, above + 1, substitution));
    }
    previous = current;
  }
  const distance = previous[b.length];
  if (distance === undefined) throw new Error("edit distance rows fell out of step");
  return distance;
}

/**
 * Catches the two ways a board forks in silence: the same word punctuated
 * differently, and a one-or-two character typo. Short slugs skip the typo rule,
 * where two letters separate genuinely different names.
 * @returns true when `candidate` most likely meant `existing`
 */
export function isConfusable(candidate: string, existing: string): boolean {
  if (candidate === existing) return false;
  if (skeleton(candidate) === skeleton(existing)) return true;
  const shortest = Math.min(candidate.length, existing.length);
  return (
    shortest >= MIN_LENGTH_FOR_TYPO && editDistance(candidate, existing) <= MAX_TYPO_DISTANCE
  );
}
