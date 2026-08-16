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
| `linearctl` binary builds (`bun run build`) | `package.json` `build` script |
| `wrangler` CLI (Cloudflare) available | `wrangler --version` (queue create only) |
| `linearctl` Linear OAuth creds in 1Password (local CLI) | `src/lib/secrets.ts` `readLinearOAuthCreds` |
| In-cluster BuildKit runner (image build) | `ci-builds` namespace self-hosted runner |
| Harbor registry reachability | `harbor.unsigned.gg/platform/linearctl` |
| OpenBao secret store (runtime creds) | ExternalSecret `linearctl-*` keys |

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

> **VERIFY the per-queue scoping actually exists when minting.** As of
> 2026-08-16 it is unconfirmed whether CF API tokens can scope to a single
> queue or only to the account-wide Queues permission group. If only
> account-wide is available, the token can write to every queue in the
> account — the HMAC envelope (`LINEARCTL_QUEUE_HMAC_KEY`, step 4) is the
> compensating control and should be treated as REQUIRED, not optional.

Store the token in OpenBao (the cluster's secret store) under the
`linearctl-cf-queue` key `api-token`; an ExternalSecret renders it into the
pod env as `CF_API_TOKEN` at runtime. For local CLI/dev, `1Password` via
`op run`.

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

The poller only starts when **all three** are present
(`readQueueEnv`, `src/core/operator.ts:47-51`). In-cluster, these come from the
`linearctl-cf-queue` ExternalSecret (OpenBao-backed) wired by the Helm chart
(`deploy/chart/templates/deployment.yaml` env refs). For local CLI/dev, export
them into the shell:

```sh
CF_ACCOUNT_ID=<your-cloudflare-account-id>
CF_QUEUE_ID=<queue-id-from-step-2>
CF_API_TOKEN=<token-from-step-3>
LINEARCTL_QUEUE_HMAC_KEY=<shared signing key>       # optional but see step 3 note
LINEARCTL_QUEUE_HMAC_KEY_PREV=<old key>             # rotation window only
LINEARCTL_QUEUE_HMAC_MODE=warn                      # migration only; default enforce
```

With a key set, queue messages must be v1 HMAC envelopes
(`{v:1, alg:"hmac-sha256", ts, sig, body}` — see `src/core/hmac-envelope.ts`;
the receiver signs at enqueue with the same key, audience-bound to the queue
name). Rollout order and rotation mechanics: `deploy/chart/values.yaml` §2b —
enabling enforce before the receiver signs REJECTS AND ACKS (destroys) every
real event. A set-but-empty key refuses startup. `/readyz` reports the
posture as `hmac: off|warn|enforce`.

All three CF vars are required for polling. If any is absent, the daemon's `handle.polling` is
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

Deploy target (PR #120 cluster contract):
- **Image build**: rootless in-cluster BuildKit (unsigned-paas
  `helm/compute/image-build` chart) run by self-hosted runners in namespace
  `ci-builds`. Source: public `https://github.com/cerebral-work/linearctl.git` at
  exact full SHA (no git clone token). Tags the image
  `harbor.unsigned.gg/platform/linearctl:git-<12-char SHA>` — never `latest`,
  never GHCR.
- **Runtime secrets** (OpenBao → ExternalSecret): `linearctl-oauth`
  (`client-id`/`client-secret` → `LINEAR_OAUTH_CLIENT_ID`/`_SECRET`), the
  `linearctl-cf-queue` keys from Step 3-4, `linearctl-llm` (`api-key` →
  `LLM_API_KEY`; base `http://llm.llm.svc.cluster.local:4000/v1`, model
  `glm-5.2`), and `linearctl-harbor-pull` (dockerconfigjson from the existing
  `platform-pull#dockerconfigjson` OpenBao key). The daemon mints its own
  app-actor Linear token at startup — no `op` binary and no personal
  `LINEAR_API_KEY` in the pod.
- **Deploy**: ArgoCD chart source `harbor.unsigned.gg/helm-charts`, chart
  `linearctl` revision `0.2.0`, plus ref-only values from unsigned-paas
  `gitops/linearctl/values.yaml`. The chart renders only a ServiceAccount (automount
  false), PDB, NetworkPolicy (DNS + HTTPS + namespace `llm:4000` egress, zero
  ingress), and the Deployment — no Service/Ingress/leader-election/ServiceMonitor.

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
| `--health` exits 1, "not alive" | no daemon listening / socket stale | `linearctl operator` running? `--check` for readiness detail |
| `loadClientCreds: partial env credentials` | only one of `LINEAR_OAUTH_CLIENT_ID`/`_SECRET` set | set BOTH (or neither, to fall back to 1Password for local CLI) |
| thought never lands | receiver not enqueuing | Step 6 receiver deployed? Step 5 webhook URL correct? |
| `--check` exits 1, "connect ENOENT" | no daemon listening | `linearctl operator` running? socket path correct? |
| `queue message REJECTED (unsupported envelope version)` | receiver not signing (or pre-cutover backlog) while operator enforces | wrong rollout order — switch to `LINEARCTL_QUEUE_HMAC_MODE=warn` until the receiver signs; rejected events are already destroyed (acked) |
| `queue message REJECTED (signature mismatch)` | key desync between receiver + operator | rotation skew — set `LINEARCTL_QUEUE_HMAC_KEY_PREV` during rotation; verify both sides read the same OpenBao property |
| `queue message REJECTED (sig malformed)` | receiver emitting non-hex/wrong-length sigs | receiver-side encoding bug (e.g. base64 instead of hex) — not a key problem |
| `queue message REJECTED (stale timestamp)` | messages older than the 10-min freshness window | queue backlog beyond window, or clock skew between receiver + operator |
| operator exits at startup: "set but EMPTY" | `LINEARCTL_QUEUE_HMAC_KEY` present but empty | present-but-empty secret (ESO sync/rotation failure) — fix the OpenBao property; deliberate unsigned mode = UNSET the var |

---

## Quick reference

```sh
# Liveness (process alive) — kubelet liveness probe
linearctl operator --health  # hits GET /healthz; exit 0 = alive, 1 = not

# Readiness (able to consume) — kubelet readiness probe
linearctl operator --check   # hits GET /readyz; exit 0 = ready, 1 = not

# Start the daemon (blocks until SIGINT/SIGTERM)
linearctl operator --json

# Build + run from source (standalone binary, no react-devtools runtime dep)
bun run build
./dist/linearctl operator --check
