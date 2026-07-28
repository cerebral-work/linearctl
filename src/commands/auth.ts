/**
 * `linearctl auth` — OAuth token lifecycle subcommand (CER-1148 / T13).
 *
 * Four verbs surface the two OAuth paths (spec §5):
 *
 *   `auth client-credentials`  Path A: mint a 30-day app-actor token (server-to-server).
 *   `auth exchange-code`       Path B: trade an authorization_code for access+refresh.
 *   `auth refresh`             Path B: refresh an expired access_token.
 *   `auth whoami`              Verify a token resolves as the expected actor.
 *
 * Existing commands' env-only `LINEAR_API_KEY` contract is unchanged; this is
 * additive. Tokens flow through stdout as JSON (the caller's responsibility to
 * capture) and are never written to disk or logs.
 */

import { printJson } from "../lib/output.js";
import {
  DEFAULT_BOT_SCOPES,
  exchangeAuthorizationCode,
  loadClientCreds,
  mintClientCredentialsToken,
  refreshAccessToken,
  verify,
} from "../core/auth.js";
import { ref } from "../lib/secrets.js";

function isoExpiry(expiresInSec: number): string {
  return new Date(Date.now() + expiresInSec * 1000).toISOString();
}

/** `linearctl auth client-credentials [--scope ...] [--json]` */
export async function authClientCredentials(opts: {
  scope?: string;
  json?: boolean;
}): Promise<void> {
  const creds = loadClientCreds();
  const scope = opts.scope ?? DEFAULT_BOT_SCOPES;
  const token = await mintClientCredentialsToken(creds, scope);
  const expiry = isoExpiry(token.expires_in);

  if (opts.json) {
    printJson({
      access_token: token.access_token,
      token_type: token.token_type,
      expires_in: token.expires_in,
      expires_at: expiry,
      scope: token.scope,
      grant: "client_credentials",
      actor: "app",
    });
    return;
  }

  // human output — the token still goes to stdout (caller captures via --json in scripts)
  process.stdout.write(
    `minted app-actor token (client_credentials)\n` +
      `  actor:     app\n` +
      `  scope:     ${token.scope}\n` +
      `  expires:   ${expiry} (in ${Math.round(token.expires_in / 86400)} days)\n` +
      `  token:     ${token.access_token}\n`,
  );
}

/** `linearctl auth exchange-code <code> [--redirect-uri ...] [--json]` */
export async function authExchangeCode(
  code: string,
  opts: { redirectUri?: string; json?: boolean },
): Promise<void> {
  const creds = loadClientCreds();
  const redirectUri = opts.redirectUri ?? creds.redirectUri;
  const token = await exchangeAuthorizationCode(creds, code, redirectUri);
  const expiry = isoExpiry(token.expires_in);

  if (opts.json) {
    printJson({
      access_token: token.access_token,
      refresh_token: token.refresh_token ?? null,
      token_type: token.token_type,
      expires_in: token.expires_in,
      expires_at: expiry,
      scope: token.scope,
      grant: "authorization_code",
      actor: "app",
    });
    return;
  }

  process.stdout.write(
    `exchanged authorization_code for access+refresh token\n` +
      `  actor:            app\n` +
      `  scope:            ${token.scope}\n` +
      `  access_expires:   ${expiry} (in ${Math.round(token.expires_in / 3600)} hours)\n` +
      `  refresh_token:    ${token.refresh_token ?? "(none returned)"}\n` +
      `  access_token:     ${token.access_token}\n`,
  );
}

/** `linearctl auth refresh <refreshToken> [--json]` */
export async function authRefresh(
  refreshToken: string,
  opts: { json?: boolean },
): Promise<void> {
  const creds = loadClientCreds();
  const token = await refreshAccessToken(creds, refreshToken);
  const expiry = isoExpiry(token.expires_in);

  if (opts.json) {
    printJson({
      access_token: token.access_token,
      refresh_token: token.refresh_token ?? null,
      token_type: token.token_type,
      expires_in: token.expires_in,
      expires_at: expiry,
      scope: token.scope,
      grant: "refresh_token",
    });
    return;
  }

  process.stdout.write(
    `refreshed access token\n` +
      `  scope:          ${token.scope}\n` +
      `  access_expires: ${expiry} (in ${Math.round(token.expires_in / 3600)} hours)\n` +
      `  access_token:   ${token.access_token}\n`,
  );
}

/** `linearctl auth whoami [--token <token>] [--json]`
 *
 * Reads a pre-exchanged dev token from 1Password by default (`dev_app_token`),
 * or accepts `--token` to verify an arbitrary token (e.g. one just minted).
 */
export async function authWhoami(opts: {
  token?: string;
  useUserToken?: boolean;
  json?: boolean;
}): Promise<void> {
  // If no --token given, resolve a dev token by op reference (don't load all creds).
  let token = opts.token;
  if (!token) {
    const fieldId = opts.useUserToken
      ? "ex2h6hzl7orh6gdrio6zeqrwia" // dev_user_token (label has trailing space — read by ID)
      : "uaoaxvx42cir2dgqdfgk7vlgca"; // dev_app_token
    const secret = await import("../lib/secrets.js").then((m) => m.readSecret(ref(fieldId)));
    token = secret.value;
  }

  const identity = await verify(token);
  if (opts.json) {
    printJson(identity);
    return;
  }

  process.stdout.write(
    `${identity.name} <${identity.email ?? "app-actor"}>\n` +
      `  actor:      ${identity.actorKind}${identity.isApp ? " (app)" : ""}\n` +
      `  id:         ${identity.id}\n` +
      `  verified:   token resolves as a ${identity.actorKind} actor\n`,
  );
}
