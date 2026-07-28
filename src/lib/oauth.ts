/**
 * Linear OAuth helpers (CER-1148 / T13).
 *
 * Two grant paths per the Linear OAuth spec (linear.app/developers):
 *  - Path A: `client_credentials` (RECOMMENDED for the revenant bot) — server-to-server,
 *    no browser, 30-day app-actor token, no refresh_token.
 *  - Path B: `authorization_code` + `actor=app` — interactive install; 24h access
 *    + refresh_token.
 *
 * Both POST `https://api.linear.app/oauth/token` with form-encoded bodies. This
 * module is pure transport: it takes credentials + a `fetch` and returns typed
 * results. It never touches 1Password, the env, or disk — wire those in at the
 * call site (`src/lib/secrets.ts`, `src/commands/auth.ts`).
 *
 * Secret handling: `client_secret` and the returned `access_token` /
 * `refresh_token` are treated as opaque strings. They flow through here on the
 * way to the caller; this module never logs them (`console.error` is reserved
 * for non-secret error context).
 */

const LINEAR_TOKEN_URL = "https://api.linear.app/oauth/token";

/** A successful token response (shape shared by both grants; refresh_token only on Path B). */
export interface OAuthTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  scope: string;
  refresh_token?: string;
}

export type FetchLike = typeof fetch;

/** Error raised when Linear's token endpoint returns non-2xx. Carries the status + body for diagnosis. */
export class OAuthError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(`${message} (status ${status}: ${body.slice(0, 200)})`);
    this.name = "OAuthError";
  }
}

/** A minimal bearer of client credentials for the OAuth grants. */
export interface ClientCredentials {
  client_id: string;
  client_secret: string;
}

function formEncode(body: Record<string, string>): string {
  return new URLSearchParams(body).toString();
}

function parseTokenResponse(res: { ok: boolean; status: number; text: () => Promise<string> }): Promise<OAuthTokenResponse> {
  return res.text().then((body) => {
    if (!res.ok) {
      throw new OAuthError("Linear token endpoint rejected the request", res.status, body);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      throw new OAuthError("Linear token endpoint returned non-JSON", res.status, body);
    }
    if (!parsed || typeof parsed !== "object" || !("access_token" in parsed)) {
      throw new OAuthError("Linear token response missing access_token", res.status, body);
    }
    return parsed as OAuthTokenResponse;
  });
}

/**
 * Path A — `client_credentials` grant. Returns a 30-day app-actor token.
 * Requires "client credentials tokens" toggled ON on the Linear OAuth app.
 * No `refresh_token` is returned; mint a fresh token on 401.
 */
export function clientCredentialsGrant(
  creds: ClientCredentials,
  scope: string,
  fetchImpl: FetchLike = fetch,
): Promise<OAuthTokenResponse> {
  return fetchImpl(LINEAR_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: formEncode({
      grant_type: "client_credentials",
      client_id: creds.client_id,
      client_secret: creds.client_secret,
      scope,
    }),
  }).then(parseTokenResponse);
}

/**
 * Path B — `authorization_code` exchange. The user approves in-browser, the
 * redirect lands at the dc callback with `?code=…`, dc forwards the code here.
 * Returns a 24h access_token + refresh_token.
 */
export function exchangeCode(
  creds: ClientCredentials,
  code: string,
  redirectUri: string,
  fetchImpl: FetchLike = fetch,
): Promise<OAuthTokenResponse> {
  return fetchImpl(LINEAR_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: formEncode({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: creds.client_id,
      client_secret: creds.client_secret,
    }),
  }).then(parseTokenResponse);
}

/**
 * Path B — refresh an expired (≤24h) access_token using its refresh_token.
 * Linear allows a 30-min grace window for replays.
 */
export function refreshToken(
  creds: ClientCredentials,
  refreshTokenValue: string,
  fetchImpl: FetchLike = fetch,
): Promise<OAuthTokenResponse> {
  return fetchImpl(LINEAR_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: formEncode({
      grant_type: "refresh_token",
      refresh_token: refreshTokenValue,
      client_id: creds.client_id,
      client_secret: creds.client_secret,
    }),
  }).then(parseTokenResponse);
}

/**
 * Verify a token by asking Linear who it resolves as. Proves `actor=app` worked:
 * the bot identity should differ from the operator's personal viewer.
 *
 * Separated from `core/whoami.ts` because this takes a raw token (not a client)
 * — verifying a freshly-minted OAuth token before committing it to a daemon.
 */
export interface VerifiedIdentity {
  isApp: boolean;
  actorKind: "app" | "user";
  name: string;
  email: string | null;
  id: string;
}

const LINEAR_GRAPHQL_URL = "https://api.linear.app/graphql";

export function verifyToken(
  accessToken: string,
  fetchImpl: FetchLike = fetch,
): Promise<VerifiedIdentity> {
  return fetchImpl(LINEAR_GRAPHQL_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: accessToken,
    },
    body: JSON.stringify({
      query:
        "query { viewer { id name email active __typename } }",
    }),
  })
    .then((res) => res.json())
    .then((body: { data?: { viewer?: { id: string; name: string; email: string | null; active: boolean; __typename: string } }; errors?: unknown }) => {
      const viewer = body?.data?.viewer;
      if (!viewer) {
        throw new OAuthError("token verification failed: no viewer in response", 0, JSON.stringify(body));
      }
      // Detect app-actor tokens. Linear returns the OAuth app actor via
      // __typename "Application" when minted fresh (client_credentials), but a
      // pre-exchanged dev_app_token comes back as __typename "User" with an
      // `@oauthapp.linear.app` service-account email. Treat either as app actor:
      // __typename is primary; the oauthapp.email suffix is the fallback signal.
      const emailLower = viewer.email?.toLowerCase() ?? "";
      const isApp = viewer.__typename === "Application" || emailLower.endsWith("@oauthapp.linear.app");
      return {
        isApp,
        actorKind: isApp ? ("app" as const) : ("user" as const),
        name: viewer.name,
        email: viewer.email,
        id: viewer.id,
      };
    });
}
