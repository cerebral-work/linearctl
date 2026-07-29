/**
 * Auth orchestration (CER-1148 / T13).
 *
 * Pure domain logic: wires `lib/oauth.ts` (transport) to `lib/secrets.ts`
 * (1Password). Command layer parses flags + formats output; this layer
 * performs the token lifecycle and returns structured results.
 */

import type { OAuthTokenResponse, VerifiedIdentity, ClientCredentials, FetchLike } from "../lib/oauth.js";
import {
  clientCredentialsGrant,
  exchangeCode,
  refreshToken as refreshTokenGrant,
  verifyToken,
} from "../lib/oauth.js";
import { readLinearOAuthCreds, type Secret } from "../lib/secrets.js";

/** Default scopes for the revenant-as-unsigned-gg-bot (assignment + mention triggers). */
export const DEFAULT_BOT_SCOPES = "read,write,app:assignable,app:mentionable";

/** Client credentials resolved from env or 1Password (secrets held in memory only). */
export interface ResolvedClientCreds {
  clientId: string;
  clientSecret: string;
  /** redacted handles for error messages without revealing values */
  redirectUri: string;
  devAppToken: Secret | null;
  devUserToken: Secret | null;
  /** Where the creds came from — surfaces in startup logs (no secret values). */
  source: "env" | "1password";
}

/**
 * Load OAuth app credentials for the operator daemon.
 *
 * Cluster-safe (PR #120): the daemon has no `op` binary in its pod. It prefers
 * the `LINEAR_OAUTH_CLIENT_ID` + `LINEAR_OAUTH_CLIENT_SECRET` env pair (rendered
 * from an OpenBao-backed Secret at runtime). An optional
 * `LINEAR_OAUTH_REDIRECT_URI` overrides the registered redirect for the CLI
 * `exchange-code` path.
 *
 * Precedence:
 *   1. Both `LINEAR_OAUTH_CLIENT_ID` + `LINEAR_OAUTH_CLIENT_SECRET` set → env
 *      path (no `op` dependency). `dev*Token` are absent (the daemon mints its
 *      own app-actor token at startup via `mintClientCredentialsToken`).
 *   2. Exactly one of the pair set → throw a clear config error. Half a cred
 *      pair is an operator footgun (a typo'd env that silently falls back to
 *      1Password and mints as a different identity).
 *   3. Neither set → fall back to 1Password (`op read`) for the local CLI,
 *      which carries the dev tokens too.
 */
export function loadClientCreds(
  readCreds: typeof readLinearOAuthCreds = readLinearOAuthCreds,
): ResolvedClientCreds {
  const envId = process.env.LINEAR_OAUTH_CLIENT_ID;
  const envSecret = process.env.LINEAR_OAUTH_CLIENT_SECRET;

  if (envId || envSecret) {
    // Partial-env is a misconfiguration, not a fallback trigger.
    if (!envId || !envSecret) {
      throw new Error(
        "linearctl OAuth: partial env credentials — set BOTH " +
          "LINEAR_OAUTH_CLIENT_ID and LINEAR_OAUTH_CLIENT_SECRET (or neither to " +
          "fall back to 1Password for local CLI). A half pair is a typo that " +
          "would silently mint as the wrong identity.",
      );
    }
    return {
      clientId: envId,
      clientSecret: envSecret,
      redirectUri: process.env.LINEAR_OAUTH_REDIRECT_URI ?? "",
      devAppToken: null,
      devUserToken: null,
      source: "env",
    };
  }

  // Neither env var set — local CLI mode: resolve from 1Password (`op read`).
  const creds = readCreds();
  return {
    clientId: creds.clientId.value,
    clientSecret: creds.clientSecret.value,
    redirectUri: creds.redirectUrl.value,
    devAppToken: creds.devAppToken,
    devUserToken: creds.devUserToken,
    source: "1password",
  };
}

/** The credentials shape the OAuth helpers want. Strips the Secret wrapping. */
function toClientCreds(creds: ResolvedClientCreds): ClientCredentials {
  return { client_id: creds.clientId, client_secret: creds.clientSecret };
}

/**
 * Path A — mint a 30-day app-actor token via client_credentials.
 * Requires "client credentials tokens" toggled ON on the Linear OAuth app.
 */
export function mintClientCredentialsToken(
  creds: ResolvedClientCreds,
  scope: string,
  fetchImpl?: FetchLike,
): Promise<OAuthTokenResponse> {
  return clientCredentialsGrant(toClientCreds(creds), scope, fetchImpl);
}

/**
 * Path B — exchange an authorization_code (from the dc redirect) for an
 * access+refresh token pair.
 */
export function exchangeAuthorizationCode(
  creds: ResolvedClientCreds,
  code: string,
  redirectUri: string,
  fetchImpl?: FetchLike,
): Promise<OAuthTokenResponse> {
  return exchangeCode(toClientCreds(creds), code, redirectUri, fetchImpl);
}

/** Path B — refresh an expired access_token (24h) using its refresh_token. */
export function refreshAccessToken(
  creds: ResolvedClientCreds,
  refreshTokenValue: string,
  fetchImpl?: FetchLike,
): Promise<OAuthTokenResponse> {
  return refreshTokenGrant(toClientCreds(creds), refreshTokenValue, fetchImpl);
}

/**
 * Verify a token resolves as the expected actor. Proves `actor=app` worked:
 * an app-actor token should return `actorKind: "app"`.
 */
export function verify(accessToken: string, fetchImpl?: FetchLike): Promise<VerifiedIdentity> {
  return verifyToken(accessToken, fetchImpl);
}
