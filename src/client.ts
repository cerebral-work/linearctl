import { LinearClient } from "@linear/sdk";

/**
 * Build a {@link LinearClient} from the `LINEAR_API_KEY` environment variable.
 *
 * The key is read from the environment only — provision it however you like (a
 * secret manager rendered into your shell, an untracked `.env`, etc.). This CLI
 * never stores, prints, or persists the key; it only reads it from the process
 * environment at call time.
 */
export function makeClient(): LinearClient {
  const apiKey = process.env.LINEAR_API_KEY;
  if (!apiKey) {
    console.error(
      "error: LINEAR_API_KEY is not set.\n" +
        "  This CLI reads a Linear personal API key from the environment.\n" +
        "  It renders from 1Password into ~/.config/zsh/secrets.env at `chezmoi apply`,\n" +
        "  or export it for one run via `op run`. See README.md → Authentication.\n" +
        "  The key is never stored or printed by this tool.",
    );
    process.exit(1);
  }
  return new LinearClient({ apiKey });
}

/**
 * Build a {@link LinearClient} from an OAuth `access_token` (app or user actor).
 *
 * The additive OAuth path (CER-1148 / T13). Accepts an already-minted token
 * (from `linearctl auth client-credentials`, `auth exchange-code`, or the
 * pre-exchanged `dev_app_token` / `dev_user_token` 1Password fields). The
 * caller is responsible for token lifecycle; this fn only wires the token
 * into the SDK.
 *
 * The token is never stored, cached, logged, or printed; it lives only for
 * the lifetime of this process. On 401, mint a fresh token and rebuild.
 */
export function makeOAuthClient(accessToken: string): LinearClient {
  return new LinearClient({ accessToken });
}

/**
 * Resolve auth at call time: prefer an explicit OAuth access token when one is
 * available, falling back to the env-only `LINEAR_API_KEY` contract existing
 * commands rely on. Returns the client + which path was taken, so callers
 * (e.g. `auth whoami` verification) can reason about the actor.
 */
export type ResolvedAuth =
  | { kind: "oauth"; client: LinearClient; accessToken: string }
  | { kind: "apiKey"; client: LinearClient };

export function resolveAuth(accessToken?: string): ResolvedAuth {
  if (accessToken) {
    return { kind: "oauth", client: makeOAuthClient(accessToken), accessToken };
  }
  return { kind: "apiKey", client: makeClient() };
}
