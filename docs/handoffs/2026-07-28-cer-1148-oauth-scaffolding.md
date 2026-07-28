# Handoff — CER-1148 OAuth scaffolding landed; all operator questions resolved

**Date:** 2026-07-28
**PR:** [#112](https://github.com/cerebral-work/linearctl/pull/112) (squash-merged `eaa1043`, on `main`)
**Ticket:** [CER-1148](https://linear.app/cerebral-work/issue/CER-1148) — `feat(agent): OAuth actor=app scaffolding`
**Status:** code + contract tests + live `whoami` + **live `client_credentials` mint** all verified (2026-07-28 handoff session). All 4 operator questions resolved; the 1P `credential` (client_secret) was refreshed and the live Path A mint now resolves the `unsigned-gg` app actor. See "Operator decisions (resolved 2026-07-28)" below.

---

## What landed

`linearctl auth` subcommand (T13 / CER-1148 / M4) — OAuth token lifecycle for the `linear-unsigned-oauth` 1Password item (the `unsigned-gg` Linear bot). **Additive**: existing commands keep the env-only `LINEAR_API_KEY` contract; the OAuth path is opt-in.

| verb | path | what |
|---|---|---|
| `auth client-credentials` | A | mint 30-day app-actor token (server-to-server, no browser) |
| `auth exchange-code <code>` | B | trade authorization_code (from dc redirect) for access+refresh |
| `auth refresh <token>` | B | refresh an expired access_token |
| `auth whoami` | — | verify a token resolves as the expected actor (app vs user) |

### Files
- `src/lib/oauth.ts` — transport: `clientCredentialsGrant`, `exchangeCode`, `refreshToken`, `verifyToken`, `OAuthError`. Form-encoded POSTs to `https://api.linear.app/oauth/token`.
- `src/lib/secrets.ts` — 1Password reader. Reads the 7 fields of item `me2kbjlb7xurnjp333vju5l7zm` (`linear-unsigned-oauth`, vault `cloud`) **by field ID**, not label — the `dev_user_token` field label has a trailing space; field IDs are stable.
- `src/core/auth.ts` — orchestration: wires transport to secrets. `DEFAULT_BOT_SCOPES = "read,write,app:assignable,app:mentionable"`.
- `src/commands/auth.ts` — CLI verb layer.
- `src/client.ts` — `makeOAuthClient(accessToken)` + `resolveAuth(accessToken?)` (additive; `makeClient()` unchanged).
- `src/index.ts` — wired the 4-verb `auth` subcommand tree.
- `test/auth.test.ts` — 9 contract tests (stubbed `fetch`, no network): grant bodies, response parsing, `OAuthError` on non-2xx, app-actor detection.
- `docs/spec.md` — §5 retired the "future work" caveat; §6.18 added; T13 marked shipped in §12.

### Verification (§6 checklist of the handoff plan)
- [x] `bun run typecheck` clean
- [x] `bun test` **272 pass / 0 fail** (+1 from 271)
- [x] `bun build` compiles + runs (`0.7.0`)
- [x] `linearctl auth whoami --json` against `dev_app_token` → **live, resolves `unsigned-gg` app actor**:
  ```json
  {"isApp": true, "actorKind": "app", "name": "unsigned-gg",
   "email": "85fba348-012d-4617-a398-e0268c99a2a8@oauthapp.linear.app",
   "id": "c69a51af-8bcd-49e6-be9a-e73a86438b7d"}
  ```
- [x] no secret in git/logs (1P read by field ID; tokens flow through stdout only on `--json`)
- [x] `linearctl auth client-credentials --json` → **live mint verified (2026-07-28)**: operator refreshed the 1P `credential` (client_secret) field after an initial `invalid_secret` rejection; the freshly-minted token resolves the `unsigned-gg` app actor via `auth whoami` (actorKind: app, isApp: true, name: unsigned-gg). No token values surfaced in this verification.

### Implementation note — app-actor detection
Linear returns a pre-exchanged `dev_app_token` viewer as `__typename: "User"` (not `"Application"`) but with an `@oauthapp.linear.app` service-account email. `verifyToken` detects app actors via **either** signal (typename primary, email suffix fallback):
```ts
const emailLower = viewer.email?.toLowerCase() ?? "";
const isApp = viewer.__typename === "Application" || emailLower.endsWith("@oauthapp.linear.app");
```
A freshly-minted `client_credentials` token will likely return `__typename: "Application"` directly; the fallback covers the dev-token path. Test covers both shapes.

---

## Operator decisions (resolved 2026-07-28 handoff session)

All 4 prior operator questions are now **answered and verified live**. The code is complete and the live `client_credentials` mint resolves the `unsigned-gg` app actor (the 1P `credential`/client_secret was refreshed by the operator after an initial `invalid_secret` rejection).

1. **"client credentials tokens" toggle** — **ON** (operator confirmed). Path A grant is enabled on the Linear app.
2. **App installed in `unsigned-gg` workspace** — **Yes** (operator confirmed). App-actor calls resolve against the workspace.
3. **Commit `client_id` as a default, or always read from 1Password?** — **Always read from 1Password** (operator confirmed). `client_id` stays in the `linear-unsigned-oauth` 1P item; no credential values committed to the repo.
4. **Dev redirect strategy** — **No `dev.` URLs.** Lyra dev cluster is decommissioning (OPS-468); all endpoints consolidate on prod `*.unsigned.gg`. Only registered redirect: `https://app.unsigned.gg/oauth/linear/callback`.

### Endpoint inventory (consolidated on `app.unsigned.gg`)

| endpoint | URL | 1P field |
|---|---|---|
| OAuth callback (Path B redirect) | `https://app.unsigned.gg/oauth/linear/callback` | `redirect_url` |
| Webhook receiver (CER-1149 follow-up) | `https://app.unsigned.gg/webhooks/linear` | `webhook_url` |

### Webhook signing (operator requirement)

Linear webhooks carry HMAC signatures. The receiver at `https://app.unsigned.gg/webhooks/linear` **must verify signatures** against the `webhook_secret` 1Password field (field ID `zfgau2zjmlgsaxam2mh24jmz6a`). The `readLinearOAuthCreds()` helper in `src/lib/secrets.ts` already reads this field; the CER-1149 webhook receiver consumes it. linearctl itself does not (it's the agent loop, not the receiver).

### 1Password field audit (`linear-unsigned-oauth`, vault `cloud`, 2026-07-28)

| field | id | role |
|---|---|---|
| `credential` | `credential` | OAuth client_secret — refreshed 2026-07-28; live mint verified |
| `client_id` | `26za4ioosshacw7vn2jwgmf4cu` | OAuth client_id |
| `webhook_url` | `73ldnmye2kavtciji4v36i3nre` | webhook receiver URL |
| `webhook_secret` | `zfgau2zjmlgsaxam2mh24jmz6a` | webhook HMAC signing secret |
| `dev_app_token` | `uaoaxvx42cir2dgqdfgk7vlgca` | pre-exchanged app token (verified live via `auth whoami`) |
| `dev_user_token` | `ex2h6hzl7orh6gdrio6zeqrwia` | pre-exchanged user token |
| `redirect_url` | `5ehgmyh4uwnli5sgrhkkmemdva` | registered OAuth redirect |

All 7 fields present and populated (field lengths omitted; secret-named fields never surfaced). Field IDs are stable regardless of label typos (the `dev_user_token` label has a trailing space).

---

## Non-goals honored (separate follow-ups, not in this PR)

- **dc frontend callback handler** (`/oauth/linear/callback`) — lives in `unsigned/gg/services/dc`. The `auth exchange-code` verb accepts the code the dc redirect produces, but the dc side is its own workstream.
- **webhook receiver** (`https://app.unsigned.gg/webhooks/linear`, HMAC signature verification against the `webhook_secret` 1P field) — consolidated on `app.unsigned.gg` per operator decision (was "revenant webhook receiver"; Lyra dev decommission per OPS-468 retires any `dev.`/`revenant.` host). The `webhook_secret` 1P field is read by `readLinearOAuthCreds()` but linearctl doesn't consume it; the CER-1149 receiver does.
- **T14 / CER-1149 — `linearctl watch`** — the AgentSessionEvent daemon. Uses the app-actor token this PR introduces; the follow-up builds the webhook subscriber loop + 10s-thought + `createAgentActivity` on top of `makeOAuthClient`.

---

## What the next linearctl session should do first

All operator questions (§7 q1–q4) are **resolved** and the live `client_credentials` mint is **verified** — there is no longer a blocker to close. The remaining steps are forward-looking:

1. **Merge PR #114** (this handoff update) once the agentic jury approves. The code PR (#112) and the punch-list update (#113) are already on `main`.
2. **Update `docs/spec.md` §6.18** — its heading still reads *"live mint pending operator gate"*; flip it to *verified* (separate follow-up; not in this PR's diff). The §12 T13 row is already accurate.
3. **Confirm the MCP-tool boundary for `auth`** (`src/mcp/serve.ts`). Currently `auth` is CLI-only — the MCP surface exposes `whoami`/`project_list`/`digest`/etc. but not `auth client-credentials`, because token minting is an operator action, not an agent action. Confirm this is the intended boundary before CER-1149 lands (the watch daemon will need to mint its own token via Path A).
4. **Start T14 / CER-1149** (`linearctl watch`) — it depends on `makeOAuthClient` + the app-actor token (now verified). Builds the webhook subscriber loop (10s thought, `createAgentActivity`) on top of the `webhook_url` + `webhook_secret` 1P fields already audited above. The receiver lives at `https://app.unsigned.gg/webhooks/linear` with HMAC signature verification against `webhook_secret`.
5. **Start CER-1188** (maintainer-agent facility) — phased, depends on CER-1149. The handoff plan's §4 architecture decision (who holds what) still governs: linearctl owns the agent loop, the `app.unsigned.gg` webhook receiver owns the entry point, dc owns the browser redirect.

## Audit artifacts (in the omp session that did this work, NOT in this repo)

The dispatch plan + audit manifests that produced this work live at:
- `~/.omp/agent/local/linearctl-oauth-handoff.md` — the full dispatch plan (§1–§7)
- `~/.omp/agent/sessions/-projects-cerebral-linearctl/…/local/` — session-local artifacts

These are operator-reference. Do not commit them. The relevant findings are captured above + in `docs/spec.md` §5/§6.18/§10/§12.
