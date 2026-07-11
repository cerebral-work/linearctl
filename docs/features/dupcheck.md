# Feature: `linearctl dupcheck` — duplicate detection before filing

**Status:** shipped — [CER-1559](https://linear.app/cerebral-work/issue/CER-1559)
**Command:** `linearctl dupcheck <title> --team CER [--threshold 0.8] [--json]`
**Roadmap:** net-new (not in §7)
**Milestone:** M3

## Motivation

The recurring footgun: you file an issue, then discover a near-identical one
already exists. This happens most during batch filing (`linearctl file` reading
from stdin) and during the park-user-stories flow — ideas recur, and without a
check you get duplicates that then need `triage` + manual merge.

`triage` surfaces issues needing triage but doesn't detect *similarity*. Linear
has no built-in duplicate detection in the API. The gap: a **pre-file check**
that surfaces likely duplicates before the create mutation fires.

## Proposal

```
linearctl dupcheck "Migrate voicenotes off pre-seed palette" --team BRAND
```

### Output (human)

```
Possible duplicates (2 ≥ 0.85 threshold):

  BRAND-3  0.92  Migrate voicenotes off pre-seed palette onto living-terminal
  BRAND-5  0.87  Decide: cerebral.work landing — editorial identity vs living-terminal

No exact match. Review before filing.
```

### Output (JSON)

```json
{
  "query": "Migrate voicenotes off pre-seed palette",
  "threshold": 0.85,
  "matches": [
    { "identifier": "BRAND-3", "score": 0.92, "title": "Migrate voicenotes..." },
    { "identifier": "BRAND-5", "score": 0.87, "title": "Decide: cerebral.work..." }
  ]
}
```

### Behavior

- Fetches active (non-canceled, non-done) issues for the team — same filter
  `triage` uses for "active state".
- Computes a similarity score between the candidate title and each active
  issue title. Algorithm: **Jaccard similarity on token sets** (lowercased,
  stopwords removed, punctuation stripped) — no external dependency, runs in
  pure TS in `lib/`. Fast enough for a team's active issue count (hundreds,
  not millions).
- `--threshold` (default `0.85`) — minimum score to report. Higher = fewer,
  tighter matches.
- `--limit` (default `5`) — cap on results.
- Read-only — no mutation, no `--apply`. The human reviews and decides.

### Integration with `file` and `park`

Optional `--check-dups` flag on `file`/`park` runs `dupcheck` first and
**refuses to create** if any match exceeds the threshold, printing the
candidates for review. `--force` overrides:

```
linearctl file "Migrate voicenotes..." --team BRAND --check-dups
  → error: 2 likely duplicates found (use --force to file anyway)
  → BRAND-3 (0.92), BRAND-5 (0.87)
linearctl file "Migrate voicenotes..." --team BRAND --check-dups --force
  → filed as BRAND-6
```

This is the highest-value integration — it catches duplicates *at the point
of creation*, not after.

## Algorithm detail

```typescript
// lib/similarity.ts
function tokenize(s: string): Set<string> {
  return new Set(
    s.toLowerCase()
      .replace(/[^\w\s]/g, " ")
      .split(/\s+/)
      .filter(t => t && !STOPWORDS.has(t))
  );
}
function jaccard(a: Set<string>, b: Set<string>): number {
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}
```

Jaccard is chosen over Levenshtein/edit-distance because:

- **Token order independence** — "migrate voicenotes palette" and "voicenotes
  palette migrate" are the same issue; edit-distance would score them low.
- **No deps** — pure set math; fits `lib/*`'s pure-helper convention.
- **Good enough** — the goal is catching obvious duplicates (score ≥ 0.85),
  not fuzzy semantic search. Semantic search would need embeddings (an
  external API or a local model) — overkill and adds a dependency for a
  pre-file guard.

## API surface

No new mutations. Reuses `triage`'s active-issues query (paginated). The
similarity computation is pure `lib/similarity.ts`.

## Non-goals

- **No semantic/embedding similarity.** Token Jaccard catches lexical
  duplicates; semantic duplicates ("migrate voicenotes" vs "retheme the voice
  notes surface") are a harder problem needing embeddings — out of scope for
  a pre-file guard.
- **No auto-merge.** Detection only; merging duplicates is a manual web-app
  action. Auto-merge is destructive (D6).
- **No cross-team duplicate check.** Teams are independent; cross-team
  dupes are usually intentional (same work, different team). Scope to one
  team.

## Alternatives considered

- **Levenshtein.** Order-sensitive, penalizes rewording. Worse for titles
  where word order varies.
- **Embedding similarity (Linear's or local).** Best quality, but needs an
  external API call or a local model — violates the "minimal deps" posture
  and adds latency to a pre-file check. Defer to a future `--semantic` flag
  if the need is proven.

## Verification

- `linearctl dupcheck "exact existing title" --team CER` → score 1.0, one
  match.
- `linearctl dupcheck "totally unrelated gibberish xyz" --team CER` → no
  matches.
- `linearctl file "exact existing title" --team CER --check-dups` → refused
  with the match; `--force` → filed.
- Threshold tuning: verify that 0.85 catches rewordings but doesn't flood
  with false positives on a team with 100+ active issues.
