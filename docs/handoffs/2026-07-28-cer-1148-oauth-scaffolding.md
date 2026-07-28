# Handoff — CER-1148 OAuth scaffolding landed; 4 operator questions open

**Date:** 2026-07-28
**PR:** [#112](https://github.com/cerebral-work/linearctl/pull/112) (squash-merged `eaa1043`, on `main`)
**Ticket:** [CER-1148](https://linear.app/cerebral-work/issue/CER-1148) — `feat(agent): OAuth actor=app scaffolding`
**Status:** code + contract tests + live `whoami` verified; 4 operator questions block live `client_credentials` mint verification only.

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
- [x] `dev_app_token` + `dev_user_token` resolve via field ID (trailing-space label bug sidestepped)

### Implementation note — app-actor detection
Linear returns a pre-exchanged `dev_app_token` viewer as `__typename: "User"` (not `"Application"`) but with an `@oauthapp.linear.app` service-account email. `verifyToken` detects app actors via **either** signal (typename primary, email suffix fallback):
```ts
const emailLower = viewer.email?.toLowerCase() ?? "";
const isApp = viewer.__typename === "Application" || emailLower.endsWith("@oauthapp.linear.app");
```
A freshly-minted `client_credentials` token will likely return `__typename: "Application"` directly; the fallback covers the dev-token path. Test covers both shapes.

---

## 4 open operator questions (§7 of the dispatch plan) — block live Path A verification only

These are **operator-gated** (Linear UI / workspace admin). The code is complete; only the live `auth client-credentials` mint can't be verified until q1 is answered. Do NOT guess on these.

1. **Is "client credentials tokens" toggled ON** for the `linear-unsigned-oauth` app in Linear Settings → API → Applications → edit? — *Required for Path A (`auth client-credentials`). The `whoami` against `dev_app_token` succeeded (proves the app actor + scopes are correct), but the `client_credentials` grant specifically needs this toggle. Operator must verify in the Linear UI.*
2. **Has the app been installed in the `unsigned-gg` workspace** (admin approval)? — The `dev_app_token` resolving as `unsigned-gg` suggests yes, but confirm: Path A tokens only see public teams until installation happens.
3. **Commit `client_id` (`d43119e2c9d81440287d9a364beb9885`) as a default, or always read from 1Password?** — Currently read from 1P for consistency with the rest of the secret. `client_id` is not secret-named, so committing it as a default is safe if you prefer config-file reuse. Recommend keeping 1P-only.
4. **Dev redirect strategy** — register `https://app.dev.unsigned.gg/oauth/linear/callback` alongside the prod URL in the Linear app so staging OAuth (Path B dev) works? Currently only `https://app.unsigned.gg/oauth/linear/callback` is registered.

**To complete verification once q1 is confirmed ON:**
```bash
cd ~/projects/cerebral/linearctl
bun build ./src/index.ts --compile --minify --outfile dist/linearctl
./dist/linearctl auth client-credentials --json   # mints a live 30-day app-actor token
./dist/linearctl auth whoami --json               # should resolve unsigned-gg app actor
```

---

## Non-goals honored (separate follow-ups, not in this PR)

- **dc frontend callback handler** (`/oauth/linear/callback`) — lives in `unsigned/gg/services/dc`. The `auth exchange-code` verb accepts the code the dc redirect produces, but the dc side is its own workstream.
- **revenant webhook receiver** (`/webhooks/linear`, signature verification against `webhook_secret`) — lives in the revenant daemon. The `webhook_secret` 1Password field is read by `readLinearOAuthCreds()` but linearctl doesn't consume it; revenant does.
- **T14 / CER-1149 — `linearctl watch`** — the AgentSessionEvent daemon. Uses the app-actor token this PR introduces; the follow-up builds the webhook subscriber loop + 10s-thought + `createAgentActivity` on top of `makeOAuthClient`.

---

## What the next linearctl session should do first

1. **Confirm q1–q4 with the operator.** If q1 is ON, run the live `auth client-credentials` mint + `whoami` to close the §6 verification checklist for Path A. If q1 is OFF, file a Linear comment on CER-1148 documenting the blocker + close the ticket as code-complete-pending-operator-toggle (the code is done; the toggle is out of code's hands).
2. **Update `PUNCH-LIST.md`** — CER-1148 is still listed under "Deferred" (line 22). Move it to "Shipped" with the PR #112 link. (I did not update PUNCH-LIST in this PR — it's a doc churn that belongs to the ticket-close step, not the code PR.)
3. **Consider whether `auth` should surface in the MCP tool list** (`src/mcp/serve.ts`). Currently `auth` is CLI-only — the MCP surface exposes `whoami`/`project_list`/`digest`/etc. but not `auth client-credentials`, because token minting is an operator action, not an agent action. Confirm this is the intended boundary.
4. **Start T14 / CER-1149** (`linearctl watch`) — it depends on this PR's `makeOAuthClient` + the app-actor token. The handoff plan's §4 architecture decision (who holds what) still governs: linearctl owns the agent loop, revenant owns the webhook receiver, dc owns the browser redirect.

## Audit artifacts (in the omp session that did this work, NOT in this repo)

The dispatch plan + audit manifests that produced this work live at:
- `~/.omp/agent/local/linearctl-oauth-handoff.md` — the full dispatch plan (§1–§7)
- `~/.omp/agent/sessions/-projects-cerebral-linearctl/…/local/` — session-local artifacts

These are operator-reference. Do not commit them. The relevant findings are captured above + in `docs/spec.md` §5/§6.18/§10/§12.
