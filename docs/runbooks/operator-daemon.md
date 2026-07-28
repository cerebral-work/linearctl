# Operator daemon — live-integration runbook (Track 4)

**Scope:** bring the `linearctl operator` daemon (CER-1149) from "code merged"
to "running in steady state against the live Linear ↔ Cloudflare Queue path."

**Ground truth:** `src/core/operator.ts` reads the queue env
(`readQueueEnv`, `src/core/operator.ts:47-51`), polls `linear-agent-events`
(`pollOnce`, `src/core/operator.ts:277-358`) at `DEFAULT_QUEUE_POLL_INTERVAL_MS`
(`src/core/operator.ts:54`), and serves `GET /healthz` (alive) + `GET /readyz`
(able-to-consume, Track 4) + `POST /delegate` over a Unix socket
(`src/core/operator.ts:189-267`). The webhook receiver edge lives in
`unsigned/gg/services/linear-webhook` (not this repo).

**Estate invariants bind every step** (`CLAUDE.md` + generic rules):
1. PR-only, signed conventional commits, squash-merge — no direct push to main.
2. Irreversible / outward-facing actions need explicit operator sign-off
   (merge, deploy, secret creation, external config).
3. **Never echo `*SECRET*` / `*TOKEN*` / `*KEY*` / `*PASSWORD*` / `*CRED*`-named
   vars.** Test presence only: `[ -n "${CF_API_TOKEN:-}" ] && echo set`.
6. Pin versions; no `latest` image tags. Never pipe remote content into `sh`.

Each step below names the invariant gate it satisfies.

---

## Prerequisites

| What | Where verified |
|------|----------------|
| Operator daemon code merged to `main` | `src/core/operator.ts` `startOperator` |
| `linearctl` binary builds (`bun build --compile`) | `package.json` `build` script |
| `wrangler` CLI (Cloudflare) available | `wrangler --version` |
| `linearctl` Linear OAuth creds in 1Password | `src/lib/secrets.ts` `readLinearOAuthCreds` |

---

## Step 1 — DNS gate: `dig app.unsigned.gg`

The webhook receiver for edge is at `https://app.unsigned.gg/webhooks/linear`
(`docs/spec.md:368` §10, prod-only — no `dev.` URLs). The receiver enqueues
Linear webhooks to the CF Queue. DNS for `app.unsigned.gg` must resolve to the
edge (Cloudflare Pages) before anything downstream can work.

```sh
dig +short app.unsigned.gg
```

**Gate:** the hostname resolves to the edge's IPs. If this returns `A` records
pointing at Cloudflare, proceed. If empty / wrong — stop; the webhook receiver
is unreachable and every later step is meaningless.

> **Invariant 1:** this is a read-only DNS query. No write, no sign-off.

---

## Step 2 — Create the Cloudflare Queue: `linear-agent-events`

The operator's poller pulls from a queue named `linear-agent-events`
(`src/core/operator.ts:25-27`, `pollOnce` `:246-248`). Create it if it doesn't
exist:

```sh
wrangler queues create linear-agent-events
```

Capture the returned queue ID — you'll set it as `CF_QUEUE_ID` in Step 4.

**Gate:** this is an infrastructure write. Get the queue name from
`src/core/operator.ts:40-44` (`QueueEnv`) — the daemon hard-codes that name.
> **Invariant 2 (`wrangler queues create`):** outward-facing infra write —
> operator sign-off required before running.

---

## Step 3 — Create a CF API token (queue-scoped)

The poller authenticates as `Bearer ${CF_API_TOKEN}`
(`src/core/operator.ts:255`, `:335`). The token needs Queues **read** (pull)
+ **write** (ack) on the one queue from Step 2 — **not** account-wide.

Create it via the Cloudflare dashboard or API:
- Permission: **Queues → Consume** (pull/ack) on `linear-agent-events` only.
- Do NOT grant account-wide Queues edit, Workers edit, or DNS edit.

Store the token in the daemon's secret store (Railway env / 1Password) as
`CF_API_TOKEN`.

**Gate:** scope the token to the single queue. Verify presence (never the
value):

```sh
[ -n "${CF_API_TOKEN:-}" ] && echo "CF_API_TOKEN: set" || echo "CF_API_TOKEN: MISSING"
```

> **Invariant 3:** **NEVER** `echo "${CF_API_TOKEN}"`, `cat` the token, or log
> it. An exposed token is compromised — rotate immediately. The operator daemon
> holds it in memory only and the `/readyz` route reports **presence-only**
> (`apiToken: !!CF_API_TOKEN`, `src/core/operator.ts:208-216`) — never the value.
> **Invariant 6:** pin the wrangler version when scripting; no `latest`.

---

## Step 4 — Set `CF_ACCOUNT_ID` + `CF_QUEUE_ID` + `CF_API_TOKEN` in daemon env

The poller only starts when **all three** are present
(`readQueueEnv`, `src/core/operator.ts:47-51`). Set them in the deploy target's
env (Railway service variables / bare-metal systemd `Environment=`):

```sh
CF_ACCOUNT_ID=<your-cloudflare-account-id>
CF_QUEUE_ID=<queue-id-from-step-2>
CF_API_TOKEN=<token-from-step-3>
```

All three are required. If any is absent, the daemon's `handle.polling` is
`false` and `/readyz` reports `cfEnv: { accountId: false, queueId: false,
apiToken: false }`.

**Gate:** presence-only check after deploy:

```sh
linearctl operator --check           # /readyz: cfEnv all true, ok true
linearctl operator --check --json    # machine-readable
```

> **Invariant 3:** the operator command banner logs `polling: on/off` only
> (`src/commands/operator.ts:85`) — never the env values. Set secrets via the
> deploy target's secret UI, not in shell history / committed env files.

---

## Step 5 — Enable "Agent session events" on the Linear OAuth app

`docs/spec.md:368` §10 requires enabling webhooks → **"Agent session events"**
(+ inbox notifications) on the Linear Application (`linear-unsigned-oauth`).
Point the webhook at:

```
https://app.unsigned.gg/webhooks/linear
```

The `client credentials tokens` toggle is ON (verified). The remaining Linear-
side config is: in the app's webhook settings, enable "Agent session events"
and set the endpoint URL above.

The receiver verifies the HMAC against the `webhook_secret` 1P field
(field ID `zfgau2zjmlgsaxam2mh24jmz6a`); linearctl reads it via
`readLinearOAuthCreds()` in `src/lib/secrets.ts` but does **not** consume it
(the receiver does).

**Gate:** this is an **outward-facing Linear Application config change** —
operator sign-off required.

> **Invariant 2:** enabling webhooks on the OAuth app is an outward-facing
> change; the operator approves before flipping it on. **Invariant 3:** never
> echo the `webhook_secret`; it's read by the receiver only.

---

## Step 6 — Deploy the webhook receiver edge

The receiver (`unsigned/gg/services/linear-webhook`) is a thin HMAC-verify +
enqueue edge — **not a linearctl file**. Deploy it so that `POST
https://app.unsigned.gg/webhooks/linear` validates the Linear HMAC and enqueues
the raw `AgentSessionEvent` body to the `linear-agent-events` queue from
Step 2.

The receiver must be deployed **before** the daemon can consume
(Step 7-9); a deployed daemon with no receiver feeding the queue will just poll
an empty queue forever.

**Gate:** verify the receiver is reachable + enqueueing after deploy:

```sh
# After a test mention (Step 8), the queue should receive a message.
wrangler queues list   # confirm linear-agent-events exists
```

> **Invariant 2:** deploy is an outward-facing infra action — operator sign-off.
> **Invariant 6:** pin the receiver's deploy image version; no `latest`.

---

## Step 7 — Smoke: `linearctl operator --json` + `--check`

Boot the daemon and confirm it is alive **and** able to consume:

```sh
# Start the daemon (blocks; the banner/json goes to stderr/stdout).
linearctl operator --json
# In another shell — liveness + readiness:
linearctl operator --check          # human report
linearctl operator --check --json   # machine report
```

Expected `--check` output when correctly configured:

```
operator readiness: READY
  cf env: accountId=true queueId=true apiToken=true
  token age: 1s
  last poll: 2026-07-28T18:42:34.571Z
  queue depth: 0
```

Exit code `0` = ready; `1` = not ready. The two probes mean different things:
- `GET /healthz` (`src/core/operator.ts:191-197`) = **"is the process alive?"**
  (uptime + queue depth).
- `GET /readyz` (`src/core/operator.ts:204-229`) = **"is it actually able to
  consume?"** — CF env present, token minted (age < 30d), and a poll has landed
  within the last 3× poll interval.

**Gate:** `--check` exits 0. If it exits 1, `/readyz` tells you why:
- `cfEnv` any `false` → Step 4 env missing.
- `lastPoll: null` / stale → poller not reaching the queue (Step 3 token? Step 2
  queue?) — check `operator: queue pull HTTP 4xx` on stderr
  (`src/core/operator.ts:300-305`).

> **Invariant 1:** read-only probe. **Invariant 3:** CF env reported
> presence-only.

---

## Step 8 — End-to-end test: mention → thought + response within 10s

Trigger the full path:
1. Mention/delegate the agent (`@unsigned-gg` or a `linearctl watch --delegate`)
   in a Linear issue.
2. The `created` AgentSessionEvent webhook fires → the receiver (Step 6) HMAC-
   verifies it → enqueues to `linear-agent-events`.
3. The operator's poller pulls (`pollOnce`, batch_size 1 for the 10s SLA,
   `src/core/operator.ts:291`) → runs `eventLoop(event, token)` →
   `emitThought` **within 10s** (`docs/spec.md:356,370`).
4. `driveAgentLoop` → `moveToStartedIfDelegated` moves the issue to Started
   (the `movedToStateId` in the `/delegate` response).

Verify on the Linear issue: a `thought` activity (~10s) then the issue moves to
Started. The daemon logs to stderr:

```
operator: handled event session=<id> thought=<id> response=<id>
```

**Gate:** the thought lands within 10s + the issue moves to Started.

> **Invariant 2:** the mention is an outward-facing action (creates an agent
> session on a real Linear issue) — operator sign-off before the test mention.
> **Invariant 3:** the prompt may contain issue descriptions — the daemon never
> logs prompts/responses verbatim.

---

## Step 9 — Steady state: queue poller at `DEFAULT_QUEUE_POLL_INTERVAL_MS`

In steady state the poller fires at `DEFAULT_QUEUE_POLL_INTERVAL_MS = 2000`
(`src/core/operator.ts:54`), batch_size 1, acking every message (even on error,
to avoid poisoning the queue — `src/core/operator.ts:340-344,352`). The token
is cached in-memory, re-minted on a 401 from Linear
(`src/core/operator.ts:372-379`).

Deploy target (per ADR-0004, `docs/decisions.md:85-92` — Docker is deferred to
exactly this M4 daemon):
- **Railway** (recommended): the daemon is a long-running `bun` process;
  `railway up` deploys from a Dockerfile. Needs `CF_*` env (Step 4) + tailnet
  LLM gateway reachability (Track 3 — the V1 echo loop runs without it).
- **K8s / bare metal** fallback if Railway can't reach the tailnet LLM gateway.

**Gate:** `/readyz` `ok: true` + `lastPoll` recent under normal load. Watch the
`operator:` stderr lines for `queue pull HTTP` (auth/reachability) and
`event loop error` (Linear API).

> **Invariant 2:** deploy target is an outward-facing infra decision — operator
> approves. **Invariant 6:** pin the deploy image version.

---

## Troubleshooting

| Symptom | Check | Fix |
|---------|-------|-----|
| `handle.polling: off` | `readQueueEnv` (`:47-51`) | all 3 `CF_*` env present (Step 4) |
| `/readyz` `ok: false`, `cfEnv` true, `lastPoll` null | poller failing to reach queue | `CF_API_TOKEN` scope (Step 3); queue ID (Step 2) |
| `queue pull HTTP 401` | CF token auth | re-create `CF_API_TOKEN` (Step 3); rotate the old one |
| `event loop error: ...401...` | Linear token expired | daemon auto-re-mints (`:372-379`); if persistent, `loadClientCreds` stale |
| thought never lands | receiver not enqueuing | Step 6 receiver deployed? Step 5 webhook URL correct? |
| `--check` exits 1, "connect ENOENT" | no daemon listening | `linearctl operator` running? socket path correct? |

---

## Quick reference

```sh
# Liveness (process alive)
linearctl operator --check   # hits GET /readyz; exit 0 = ready, 1 = not

# Start the daemon (blocks until SIGINT/SIGTERM)
linearctl operator --json

# Build + run from source
bun build src/index.ts --compile --outfile linearctl
./linearctl operator --check
```
