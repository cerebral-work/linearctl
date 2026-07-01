import { describe, expect, test } from "bun:test";
import { parseRateLimitHeaders, isExhausted } from "../src/core/ratelimit.js";

function headerGetter(map: Record<string, string>): (name: string) => string | null {
  const lower = Object.fromEntries(Object.entries(map).map(([k, v]) => [k.toLowerCase(), v]));
  return (name) => lower[name.toLowerCase()] ?? null;
}

describe("parseRateLimitHeaders", () => {
  test("parses the full Linear header set (reset = UTC epoch ms)", () => {
    const info = parseRateLimitHeaders(
      headerGetter({
        "X-RateLimit-Requests-Limit": "2500",
        "X-RateLimit-Requests-Remaining": "1487",
        "X-RateLimit-Requests-Reset": "1783190000000",
        "X-RateLimit-Complexity-Limit": "250000",
        "X-RateLimit-Complexity-Remaining": "249000",
        "X-RateLimit-Complexity-Reset": "1783190000000",
      }),
    );
    expect(info.requests).toEqual({
      limit: 2500,
      remaining: 1487,
      resetAt: "2026-07-04T18:33:20.000Z",
    });
    expect(info.complexity.limit).toBe(250000);
    expect(info.complexity.remaining).toBe(249000);
  });

  test("absent headers resolve to nulls, not NaN", () => {
    const info = parseRateLimitHeaders(headerGetter({}));
    expect(info.requests).toEqual({ limit: null, remaining: null, resetAt: null });
    expect(info.complexity).toEqual({ limit: null, remaining: null, resetAt: null });
  });

  test("malformed numeric header resolves to null", () => {
    const info = parseRateLimitHeaders(
      headerGetter({ "X-RateLimit-Requests-Remaining": "soon" }),
    );
    expect(info.requests.remaining).toBeNull();
  });
});

describe("isExhausted", () => {
  const base = { limit: 2500, remaining: 100, resetAt: null };
  test("zero remaining on either axis is exhausted", () => {
    expect(
      isExhausted({ requests: { ...base, remaining: 0 }, complexity: base }),
    ).toBe(true);
    expect(
      isExhausted({ requests: base, complexity: { ...base, remaining: 0 } }),
    ).toBe(true);
  });
  test("positive headroom is not exhausted", () => {
    expect(isExhausted({ requests: base, complexity: base })).toBe(false);
  });
  test("unknown (null) headroom is not exhausted — probe failure must not abort batches", () => {
    const unknown = { limit: null, remaining: null, resetAt: null };
    expect(isExhausted({ requests: unknown, complexity: unknown })).toBe(false);
  });
});
