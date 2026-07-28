import { describe, expect, test, mock } from "bun:test";
import {
  clientCredentialsGrant,
  exchangeCode,
  refreshToken,
  verifyToken,
  OAuthError,
  type FetchLike,
} from "../src/lib/oauth.js";

/**
 * Contract tests for the OAuth helpers (CER-1148 / T13).
 *
 * Stubs `fetch` (no network) to assert the OAuth helpers:
 *  - POST the correct grant_type + form-encoded body to the token endpoint
 *  - parse the documented Linear response shape (access_token/expires_in/scope)
 *  - surface non-2xx as OAuthError (so callers can retry on 401)
 *  - distinguish app vs user actor via __typename on verifyToken
 */

const CREDS = { client_id: "cid-test", client_secret: "secret-test" };

/** Build a stub fetch returning the given JSON body + status. Captures the request for assertions. */
function stubFetch(
  response: { ok?: boolean; status?: number; body: unknown },
): FetchLike & { lastUrl: string; lastBody: string; lastHeaders: Record<string, string> } {
  const calls = { lastUrl: "", lastBody: "", lastHeaders: {} as Record<string, string> };
  const status = response.status ?? 200;
  const fn = (async (url: string, init?: RequestInit) => {
    calls.lastUrl = url as string;
    calls.lastBody = String(init?.body ?? "");
    const headers: Record<string, string> = {};
    if (init?.headers) {
      const h = init.headers as Record<string, string>;
      for (const [k, v] of Object.entries(h)) headers[k] = v;
    }
    calls.lastHeaders = headers;
    return {
      ok: response.ok ?? (status >= 200 && status < 300),
      status,
      text: async () => JSON.stringify(response.body),
      json: async () => response.body,
      headers: { get: () => null },
    } as unknown as Response;
  }) as FetchLike & typeof calls;
  // expose calls via property getters so assertions read live values
  Object.defineProperties(fn, {
    lastUrl: { get: () => calls.lastUrl },
    lastBody: { get: () => calls.lastBody },
    lastHeaders: { get: () => calls.lastHeaders },
  });
  return fn;
}

describe("clientCredentialsGrant (Path A)", () => {
  test("POSTs client_credentials form body to the token endpoint and parses the response", async () => {
    const f = stubFetch({
      body: {
        access_token: "tok-30d",
        token_type: "Bearer",
        expires_in: 2591999,
        scope: "read,write,app:assignable",
      },
    });
    const token = await clientCredentialsGrant(CREDS, "read,write", f);

    expect(f.lastUrl).toBe("https://api.linear.app/oauth/token");
    expect(f.lastHeaders["Content-Type"]).toBe("application/x-www-form-urlencoded");
    expect(f.lastBody).toContain("grant_type=client_credentials");
    expect(f.lastBody).toContain("client_id=cid-test");
    expect(f.lastBody).toContain("client_secret=secret-test");
    expect(f.lastBody).toContain("scope=read%2Cwrite");
    expect(token.access_token).toBe("tok-30d");
    expect(token.expires_in).toBe(2591999);
    expect(token.refresh_token).toBeUndefined();
    expect(token.scope).toBe("read,write,app:assignable");
  });

  test("throws OAuthError on non-2xx (so the caller can mint a fresh token on 401)", async () => {
    const f = stubFetch({ status: 401, body: { error: "invalid_client" } });
    await expect(clientCredentialsGrant(CREDS, "read", f)).rejects.toBeInstanceOf(OAuthError);
    try {
      await clientCredentialsGrant(CREDS, "read", f);
    } catch (e) {
      expect(e).toBeInstanceOf(OAuthError);
      expect((e as OAuthError).status).toBe(401);
    }
  });

  test("throws when the response omits access_token", async () => {
    const f = stubFetch({ body: { token_type: "Bearer", expires_in: 1, scope: "read" } });
    await expect(clientCredentialsGrant(CREDS, "read", f)).rejects.toBeInstanceOf(OAuthError);
  });
});

describe("exchangeCode (Path B)", () => {
  test("POSTs authorization_code grant with code + redirect_uri, returns access+refresh", async () => {
    const f = stubFetch({
      body: {
        access_token: "tok-24h",
        refresh_token: "rt-1",
        token_type: "Bearer",
        expires_in: 86399,
        scope: "read,write",
      },
    });
    const token = await exchangeCode(CREDS, "code-abc", "https://app.unsigned.gg/oauth/linear/callback", f);

    expect(f.lastBody).toContain("grant_type=authorization_code");
    expect(f.lastBody).toContain("code=code-abc");
    expect(f.lastBody).toContain("redirect_uri=https%3A%2F%2Fapp.unsigned.gg");
    expect(token.refresh_token).toBe("rt-1");
  });
});

describe("refreshToken (Path B refresh)", () => {
  test("POSTs refresh_token grant and returns a new access_token", async () => {
    const f = stubFetch({
      body: {
        access_token: "tok-fresh",
        refresh_token: "rt-2",
        token_type: "Bearer",
        expires_in: 86399,
        scope: "read,write",
      },
    });
    const token = await refreshToken(CREDS, "rt-1", f);

    expect(f.lastBody).toContain("grant_type=refresh_token");
    expect(f.lastBody).toContain("refresh_token=rt-1");
    expect(token.access_token).toBe("tok-fresh");
    expect(token.refresh_token).toBe("rt-2");
  });
});

describe("verifyToken", () => {
  test("returns actorKind='app' when viewer __typename is Application", async () => {
    const f = stubFetch({
      body: {
        data: {
          viewer: {
            id: "app-uuid",
            name: "unsigned-gg",
            email: null,
            active: true,
            __typename: "Application",
          },
        },
      },
    });
    const identity = await verifyToken("tok-app", f);
    expect(identity.actorKind).toBe("app");
    expect(identity.isApp).toBe(true);
    expect(identity.name).toBe("unsigned-gg");
    expect(identity.email).toBeNull();
  });


  test("detects app actor via @oauthapp.linear.app email fallback (dev_app_token shape)", async () => {
    // Linear returns dev_app_token viewers as __typename "User" with an
    // @oauthapp.linear.app service-account email. The typename heuristic alone
    // misses this; the email suffix is the fallback signal.
    const f = stubFetch({
      body: {
        data: {
          viewer: {
            id: "app-uuid",
            name: "unsigned-gg",
            email: "85fba348-012d-4617-a398-e0268c99a2a8@oauthapp.linear.app",
            active: true,
            __typename: "User",
          },
        },
      },
    });
    const identity = await verifyToken("tok-dev-app", f);
    expect(identity.actorKind).toBe("app");
    expect(identity.isApp).toBe(true);
    expect(identity.name).toBe("unsigned-gg");
  });
  test("returns actorKind='user' when viewer __typename is User", async () => {
    const f = stubFetch({
      body: {
        data: {
          viewer: {
            id: "user-uuid",
            name: "Christian Todie",
            email: "chris@todie.io",
            active: true,
            __typename: "User",
          },
        },
      },
    });
    const identity = await verifyToken("tok-user", f);
    expect(identity.actorKind).toBe("user");
    expect(identity.isApp).toBe(false);
    expect(identity.email).toBe("chris@todie.io");
  });

  test("throws when the response has no viewer (bad token)", async () => {
    const f = stubFetch({ body: { errors: [{ message: "unauthenticated" }] } });
    await expect(verifyToken("bad", f)).rejects.toBeInstanceOf(OAuthError);
  });
});
