/** A label as far as resolution cares — `{ id, name }` from `issueLabels`. */
export interface NamedLabel {
  id: string;
  name: string;
}

/**
 * Map requested label names to their IDs, case-insensitively.
 *
 * Pure so it can be unit-tested without a live client (the caller fetches the
 * `available` set). Throws — listing every unmatched name — rather than silently
 * dropping labels, so a typo never produces a half-labelled issue.
 */
export function pickLabelIds(
  available: NamedLabel[],
  requested: string[],
): string[] {
  if (requested.length === 0) return [];
  const byName = new Map(available.map((l) => [l.name.toLowerCase(), l.id]));
  const ids: string[] = [];
  const missing: string[] = [];
  for (const name of requested) {
    const id = byName.get(name.trim().toLowerCase());
    if (id) ids.push(id);
    else missing.push(name);
  }
  if (missing.length) {
    throw new Error(
      `unknown label(s): ${missing.map((m) => JSON.stringify(m)).join(", ")} — ` +
        `create them in Linear or check spelling.`,
    );
  }
  return ids;
}
