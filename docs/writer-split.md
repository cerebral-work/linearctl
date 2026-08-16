# Linear writer split — three automated writers, one tracker

**Status:** ratified (ecosystem program S1–S23 wholesale ratification,
2026-08-16), with the terrarium writer inventory folded in per the bridge
ruling. This doc is the ownership partition every automated Linear writer on
the estate operates inside. Linear is last-writer-wins with no transactions:
the split is **scope partition, not conflict resolution**.

The three writers:

| Writer | Identity | Where it runs |
|---|---|---|
| **soma WorkSource funnel** | personal `LINEAR_API_KEY` | in production (soma dispatch chain) |
| **linearctl operator** | OAuth app-actor (bot) | in-cluster ns `linearctl` (paused pending rebuild, OPS-1214) |
| **terrarium release CI** | workspace `LINEAR_API_KEY` (GitHub Actions secret) | on every surface deploy (`_linear-release-surface.yml` → `linear-release-sync.py`) |

## 1. Ownership table

| Surface | Owner | Rule |
|---|---|---|
| State transitions on funnel-claimed tickets (label `soma-ingest`, any team) | **soma, exclusively** | The linearctl operator performs **zero** writes of any kind on a `soma-ingest` ticket — transitions, comments, labels included. Enforced mechanically at the guardrail checkpoint (`src/core/guardrails.ts`, deny labels). The one exception: the watch path's delegate-skip notice comment, pending soma-lane confirmation that its re-examine path tolerates it. |
| State transitions on delegated (human-mentioned) non-funnel tickets | linearctl operator | Its only transition surface; follows explicit human delegation. Skipped (with a notice) when the ticket carries `soma-ingest`. |
| Issue creation | linearctl operator (TicketIntent path, `docs/ticket-intent-contract.md`) | Create-only by contract. soma's funnel and terrarium's CI do not create issues. |
| Comments | soma + linearctl operator, additive, namespaced | Every operator/role comment opens with its provenance line; soma's verdict comments carry soma's marker. Neither edits or deletes the other's comments (neither has an edit path — keep it that way). Terrarium writes no comments. |
| Labels | partitioned by prefix | soma owns the `soma-*` namespace on all teams. linearctl roles own grooming/stale labels on their configured team (`LINEARCTL_AGENT_TEAM`, CER) only. Terrarium writes no labels. |
| Issue title / description, post-creation | **no automated writer** | Invariant on all three sides (funnel contract §2.1; TicketIntent create-only; terrarium has no issue-write code path). The OPS-448 description-wipe class stays dead. |
| `Release` / `ReleasePipeline` objects | **terrarium CI, exclusively** | The only writer to this object class in the estate (single mutation: `releaseSync`). The operator and soma perform zero Release-object writes. No partition needed — no other writer is present. Release-object writes are **out of scope for the operator's guardrail checkpoint** (confirmed: there is no issue-mutation path to deny). |
| Issue↔Release association (`issueReferences`) | terrarium, derived | Not a chosen write: identifiers are harvested from commit messages by regex across ALL team prefixes — a terrarium release can and does reference tickets outside RD (verified: v1.1.0 referenced CER + BIZ identifiers), including potentially `soma-ingest` tickets. See §3. |

## 2. Attribution — identities must stay distinguishable

The split's forensic property is that every write is attributable in the
ticket activity log. That holds between the operator (app-actor bot) and
either key-based writer — but **soma and terrarium both write with API keys**,
and if those keys resolve to the same Linear user, those two writers are
indistinguishable in the activity log.

**Open item (operator-gated, needs both secrets):** resolve each key's
identity (`linearctl whoami` under each) and record here:

- soma funnel key → *unresolved*
- terrarium CI key → *unresolved*

If they collide, mint a distinct key for one of them. Until resolved, treat
soma/terrarium attribution in the activity log as unreliable.

## 3. The `updatedAt` hazard — soma's idempotency key

soma keys funnel idempotency on `issue.updatedAt` (funnel contract §1). Any
write that bumps a funnel ticket's `updatedAt` can trigger a soma re-examine.

- **linearctl operator:** contained — `soma-ingest` tickets are read-only to
  it entirely (guardrail deny).
- **terrarium:** the one **unverified** collision path. Whether attaching an
  `issueReference` to a Release bumps the referenced issue's `updatedAt` is
  unknown (the empirical test is specced in the terrarium writer-inventory
  doc §4). **Accepted resolution (this split's ruling):** skip the test;
  terrarium implements the containment unconditionally — filter
  `soma-ingest`-labeled identifiers out of `issueReferences` before
  `releaseSync` (one label read per referenced issue, once per release).
  Cheaper than the coordination, correct regardless of the answer.
  Implementation goes through terrarium's own ladder; **not implemented as of
  2026-08-16** — tracked as a program follow-up.

## 4. Collision rule — defense in depth

Should partition fail anyway: on any detected concurrent modification (a
verify-by-re-read returning state the writer didn't write), the automated
writer **stops** — no retry, no "fix", log both states, park to its dead
letter / escalation surface. Divergence between two automated writers is
operator-escalation territory, never automated reconciliation (OPS-448
doctrine).

## 5. Enforcement map

| Rule | Mechanism | Status |
|---|---|---|
| Operator deny on `soma-ingest` | `src/core/guardrails.ts` deny labels (checkpoint + batch partition) | merged (PR #136) |
| Operator write caps | HOLD switch + mutation budget + rate-limit preflight | merged (PR #136) |
| Queue forgery defense | HMAC envelopes (consumer verify) | merged (PR #137); receiver-side signing pending in `unsigned/gg` |
| Terrarium `issueReferences` filter | `linear-release-sync.py` label filter | **pending** (terrarium ladder) |
| soma-side rules | funnel contract invariants (state-only transitions, no description round-trip) | live, contract-tested |
| Attribution resolution | `whoami` under both API keys | **pending** (operator-gated) |
