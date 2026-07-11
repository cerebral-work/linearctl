/**
 * Token-set similarity for duplicate detection (docs/features/dupcheck.md).
 * Jaccard over lowercased, stopword-stripped tokens: order-independent (title
 * rewordings score high), dependency-free, linear in title length. Chosen over
 * edit distance (order-sensitive) and embeddings (external dep) by design.
 */

const STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "of", "to", "in", "on", "for",
  "with", "is", "are", "be", "as", "at", "by", "it", "its", "from",
]);

export function tokenize(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .replace(/[^\w\s]/g, " ")
      .split(/\s+/)
      .filter((t) => t && !STOPWORDS.has(t)),
  );
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

export interface ScoredCandidate<T> {
  item: T;
  score: number;
}

/** Score candidates against a query title; ≥threshold, best-first, capped. */
export function scoreCandidates<T>(
  query: string,
  candidates: T[],
  titleOf: (item: T) => string,
  threshold: number,
  limit: number,
): ScoredCandidate<T>[] {
  const q = tokenize(query);
  return candidates
    .map((item) => ({ item, score: jaccard(q, tokenize(titleOf(item))) }))
    .filter((c) => c.score >= threshold)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
