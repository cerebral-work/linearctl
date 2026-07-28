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

/** Client credentials resolved from 1Password (secrets held in memory only). */
export interface ResolvedClientCreds {
  clientId: string;
  clientSecret: string;
  /** redacted handles for error messages without revealing values */
  redirectUri: string;
  devAppToken: Secret | null;
  devUserToken: Secret | null;
}

/** Load OAuth app credentials from 1Password. Throws if `op` is unsigned-in or fields are missing. */
export function loadClientCreds(): ResolvedClientCreds {
  const creds = readLinearOAuthCreds();
  return {
    clientId: creds.clientId.value,
    clientSecret: creds.clientSecret.value,
    redirectUri: creds.redirectUrl.value,
    devAppToken: creds.devAppToken,
    devUserToken: creds.devUserToken,
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
