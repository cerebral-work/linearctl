import { cliError } from "../lib/errors.js";
/**
 * Rate-limit introspection (spec §7 item 7, T18).
 *
 * Linear reports quota in `X-RateLimit-*` response headers (reset = UTC epoch
 * ms) but only alongside a real request — there is no dedicated quota query.
 * `fetchRateLimit` issues the cheapest possible request (viewer id, complexity
 * 1) and reads the headers off the raw response, bypassing `@linear/sdk`
 * (which swallows response headers on its happy path).
 */

export interface RateLimitAxis {
  limit: number | null;
  remaining: number | null;
  resetAt: string | null;
}

export interface RateLimitInfo {
  requests: RateLimitAxis;
  complexity: RateLimitAxis;
}

function num(raw: string | null): number | null {
  if (raw === null || raw.trim() === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function epochMsToIso(raw: string | null): string | null {
  const ms = num(raw);
  return ms === null ? null : new Date(ms).toISOString();
}

/** Parse Linear's rate-limit headers via a case-insensitive getter (e.g. `Headers.get`). */
export function parseRateLimitHeaders(
  get: (name: string) => string | null,
): RateLimitInfo {
  const axis = (kind: "Requests" | "Complexity"): RateLimitAxis => ({
    limit: num(get(`X-RateLimit-${kind}-Limit`)),
    remaining: num(get(`X-RateLimit-${kind}-Remaining`)),
    resetAt: epochMsToIso(get(`X-RateLimit-${kind}-Reset`)),
  });
  return { requests: axis("Requests"), complexity: axis("Complexity") };
}

/**
 * Zero remaining on either axis. Unknown (null) is NOT exhausted: a probe that
 * couldn't see headers must not abort a batch that might have headroom.
 */
export function isExhausted(info: RateLimitInfo): boolean {
  return info.requests.remaining === 0 || info.complexity.remaining === 0;
}

const LINEAR_GRAPHQL_URL = "https://api.linear.app/graphql";

/**
 * Probe the org quota with a minimal viewer query; parse headers off the raw
 * response. `auth` is the full Authorization header value: a personal API key
 * raw (Linear accepts it bare), or `Bearer <token>` for OAuth actors (the
 * operator's app-actor token).
 */
export async function fetchRateLimit(auth: string): Promise<RateLimitInfo> {
  const res = await fetch(LINEAR_GRAPHQL_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: auth },
    body: JSON.stringify({ query: "{ viewer { id } }" }),
  });
  const body = await res.json() as { errors?: Array<{ extensions?: { type?: string; code?: string } }> };
  if (!res.ok || body.errors?.length) {
    const error = Object.assign(new Error(`Linear quota probe failed (HTTP ${res.status}).`), { status: res.status, errors: body.errors });
    const failure = cliError(error);
    // Exhausted quota is useful data to the scheduler; other failures must not look healthy.
    if (failure.kind !== "rate_limit") throw failure;
    const info = parseRateLimitHeaders(n => res.headers.get(n));
    if (!isExhausted(info)) throw failure;
    return info;
  }
  return parseRateLimitHeaders(n => res.headers.get(n));
}
