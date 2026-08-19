/**
 * A natural-language question never matches: websearch_to_tsquery ANDs every
 * term, and the simple configuration keeps stopwords as real lexemes. This
 * builds an OR of the same words so ts_rank can order them, used only as a
 * fallback so quoted phrases and exclusions still work when they find something.
 */
export function looseQuery(query: string): string | null {
  const words = query
    .toLowerCase()
    .split(/[^\p{L}\p{N}_]+/u)
    .filter((word) => word.length > 1);
  return words.length === 0 ? null : words.join(" | ");
}
