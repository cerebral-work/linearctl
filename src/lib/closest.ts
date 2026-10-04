/** Levenshtein distance for short user-facing name suggestions. */
function distance(a: string, b: string): number {
  let row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 0; i < a.length; i++) {
    const next = [i + 1];
    for (let j = 0; j < b.length; j++) next.push(Math.min(next[j] + 1, row[j + 1] + 1, row[j] + (a[i] === b[j] ? 0 : 1)));
    row = next;
  }
  return row[b.length];
}
export function closestNames(requested: string[], available: string[]): string[] {
  return [...new Set(available)].map(name => ({ name, score: Math.min(...requested.map(r => distance(r.toLowerCase().trim(), name.toLowerCase()))) }))
    .sort((a, b) => a.score - b.score || a.name.localeCompare(b.name)).slice(0, 3).map(x => x.name);
}
