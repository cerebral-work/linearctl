# TicketIntent contract — actuator seam, producers → linearctl operator → Linear

**Status:** contract, v1alpha1. Ratified as part of the ecosystem integration
program (operator rulings 2026-08-16). Peer of `docs/funnel-contract.md` (the
soma pull/control edge); this doc governs the *create* edge — how in-cluster
producers (revenant first; cortex next) turn audit/sensing events into Linear
tickets THROUGH the linearctl operator. Consumer implementation tracks this
doc; the contract is the source of truth.

Companion: `docs/writer-split.md` (the three-way Linear writer ownership
partition this contract operates inside).

---

## 1. Transport — the `linear-ticket-intents` queue

A **dedicated Cloudflare Queue**, separate from `linear-agent-events`. The two
flows have opposite failure semantics and must not share a queue:

| | `linear-agent-events` (session events) | `linear-ticket-intents` (this contract) |
|---|---|---|
| Failure posture | ack-on-error (losing one is fine; retrying risks duplicate agent activity) | **ack only on verified success or permanent rejection**; transient failure → unacked → redelivery |
| Retry | none | CF visibility-timeout redelivery, `max_retries: 3` |
| Dead letter | none | `linear-ticket-intents-dlq` |

- **Producer path:** HTTPS push — `POST /accounts/{acct}/queues/{qid}/messages`
  — with a producer-scoped CF API token rendered by ESO into the producer's
  namespace (revenant: OpenBao `secret/revenant/cf-queue-producer`). **No
  Linear credential of any kind in a producer namespace, ever** — the queue is
  the trust boundary.
- **Consumer path:** the linearctl operator, with its own consumer token
  (`secret/linearctl/cf-queue-consumer`). Producer and consumer tokens are
  distinct.
- **Signing:** every message on this queue is a v1 HMAC envelope
  (`src/core/hmac-envelope.ts`): `{v:1, alg:"hmac-sha256", sig, body}` — the
  producer signs the raw intent JSON at enqueue with the shared intents key
  (OpenBao `secret/linearctl/intents-hmac`, key distinct from the
  session-event queue's key); the consumer verifies before parsing. CF Queues
  tokens scope account-wide, so queue write access alone must not reach the
  filing path. An unsigned or non-verifying message is a **permanent
  rejection** (→ DLQ, reason `bad-signature`).

## 2. Message schema — `TicketIntent` v1alpha1

The inner `body` of the envelope:

```json
{
  "kind": "TicketIntent",
  "apiVersion": "linearctl.cerebral.work/v1alpha1",
  "intentId": "<ULID — unique per emission, tracing only>",
  "dedupKey": "<producer>:<rule-id>:<subject>:<time-bucket>",
  "source": {
    "system": "revenant | cortex | ...",
    "stream": "revenant:audit",
    "eventId": "<origin event id, e.g. Redis stream entry id>",
    "emittedAt": "<ISO-8601 UTC>"
  },
  "gate": {
    "tier": "和面 | 赤鬼",
    "attestation": "<godseat decision id / fjall journal ref>"
  },
  "ticket": {
    "team": "OPS | CER | TOD",
    "title": "<= 200 chars",
    "description": "<= 16 KiB markdown",
    "labels": ["revenant", "audit"],
    "priority": 0,
    "project": null
  },
  "options": {
    "onDuplicate": "skip | comment | file-anyway",
    "dupThreshold": 0.85
  }
}
```

Field rules:

- `dedupKey` is the **idempotency key** — deterministic from rule + subject +
  a coarse time bucket (default 24h), so replays, redeliveries, and re-fired
  sensors collapse to one ticket. `intentId` is per-emission tracing only.
- Unknown fields are ignored; fields are never renamed without an `apiVersion`
  bump (same stability posture as the funnel contract).
- `ticket.description` MUST NOT contain ticket-identifier tokens
  (`TEAM-123`-style) — the OPS-448 mention-fanout class. Cross-references are
  full Linear URLs, max 3 per body. Violation → DLQ, reason `mention-fanout`.

## 3. Gate of record — godseat, for every producer

**`gate.attestation` is mandatory.** The operator does not evaluate governance
— godseat already did — but it refuses to act on an unattested intent
(→ DLQ, reason `no-attestation`), so a compromised or misconfigured producer
cannot bypass the govern step by writing to the queue.

**Cortex ruling (operator, 2026-08-16):** cortex-originated intents
(`source.system: "cortex"`) are godseat-gated **in addition to** cortex's own
internal guard. There is **one gate of record on the actuator seam: godseat.**
Cortex's guard may reject earlier (fine — fewer intents emitted), but it never
substitutes: a cortex intent whose `gate.attestation` is not a godseat
decision reference is rejected exactly like an unattested revenant intent.
The same rule generalizes: any future producer's internal safety layer is
additive; godseat attestation is the constant.

## 4. Consumer semantics — create-only, verified, deduped

1. **Create-only.** A TicketIntent may only *create* an issue (plus at most
   one provenance comment on a detected duplicate). It never updates an
   existing issue's description, title, or state (see the description-wipe
   invariant in `docs/funnel-contract.md` §2.1).
2. **Writer-split check.** A newly filed intent ticket never carries a deny
   label (`soma-ingest`) unless the producer explicitly routes into soma's
   funnel — in which case ownership transfers to soma at creation
   (`docs/writer-split.md`).
3. **Dedup, two layers:**
   - *Exact-replay (authoritative):* every filed ticket's description ends
     with a provenance footer containing the `dedupKey`. Before filing, the
     consumer searches for the dedupKey (server-side text match). Hit →
     replay: ack, optionally comment per `options.onDuplicate`. Linear itself
     is the ledger; the operator pod stays stateless.
   - *Fuzzy (advisory):* title-similarity (`dupcheck` core) against the
     intent's team at `options.dupThreshold` (default 0.85). Match → behavior
     per `onDuplicate` (default `skip` + one provenance comment carrying the
     dedupKey on the existing ticket).
4. **Per-write verify.** After `issueCreate`, re-read the created issue and
   compare title + sha256(description) against the intent. Mismatch → DLQ
   with both hashes, no retry — divergence between automated writers is
   operator-escalation territory, never automated reconciliation.
5. **Ack discipline.** Ack after the verified re-read (or on permanent
   rejection). A crash after create but before ack redelivers; dedup layer 1
   catches the footer; no duplicate ticket.
6. **Containment.** All filing passes the operator's containment set: HOLD
   switch, per-run mutation budget, rate-limit preflight, and the guardrail
   checkpoint (`src/core/guardrails.ts`).

## 5. Rate caps

Producer-side: ≤ 60 intents/hour per producer (enforced at the producer;
stated here as contract). Consumer-side: the mutation budget and rate-limit
preflight bound the filing rate independently — defense in both places.

## 6. Permanent-rejection reasons (DLQ taxonomy)

`bad-signature` · `not-json` · `schema-violation` (missing/oversize fields) ·
`no-attestation` · `mention-fanout` · `verify-mismatch` · `unknown-team`.
Everything else is transient → unacked → redelivery → DLQ after 3 attempts
with reason `retries-exhausted`.

## 7. Status

This contract is ratified; the consumer is **not yet implemented** (the
operator today consumes only `linear-agent-events`). Implementation lands as
its own PR set behind the write-enablement gate; nothing in this doc is
retroactive about current behavior.
