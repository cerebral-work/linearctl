import { describe, expect, test } from "bun:test";
import {
  makeEnvelope,
  signBody,
  verifyEnvelope,
  AUDIENCE_AGENT_EVENTS,
  DEFAULT_MAX_AGE_MS,
} from "../src/core/hmac-envelope.js";

const KEY = "test-shared-key";
const AUD = AUDIENCE_AGENT_EVENTS;
const NOW = 1_755_300_000_000; // fixed epoch ms for deterministic freshness

const fresh = (body: string, key = KEY, aud = AUD) => makeEnvelope(key, aud, body, NOW);
const verify = (raw: string, opts: Parameters<typeof verifyEnvelope>[3] = {}) =>
  verifyEnvelope(KEY, AUD, raw, { nowMs: NOW, ...opts });

describe("hmac envelope (queue forgery defense)", () => {
  test("round-trip: sign then verify returns the inner body", () => {
    const body = JSON.stringify({ action: "created", agentSession: { id: "s1" } });
    const verdict = verify(fresh(body));
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(verdict.body).toBe(body);
  });

  test("wrong key fails with signature mismatch", () => {
    const verdict = verify(fresh("{}", "other-key"));
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toBe("signature mismatch");
  });

  test("previous key verifies during rotation", () => {
    const verdict = verify(fresh("{}", "old-key"), { prevKey: "old-key" });
    expect(verdict.ok).toBe(true);
  });

  test("audience binding: an envelope signed for another queue fails here", () => {
    const verdict = verify(fresh("{}", KEY, "linear-ticket-intents"));
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toBe("signature mismatch");
  });

  test("stale timestamp is rejected AFTER signature (authentic-but-old is distinguishable)", () => {
    const old = makeEnvelope(KEY, AUD, "{}", NOW - DEFAULT_MAX_AGE_MS - 1);
    const verdict = verify(old);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toBe("stale timestamp");
  });

  test("future-skewed timestamp beyond the window is rejected", () => {
    const future = makeEnvelope(KEY, AUD, "{}", NOW + DEFAULT_MAX_AGE_MS + 1);
    const verdict = verify(future);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toBe("stale timestamp");
  });

  test("tampered body fails", () => {
    const env = JSON.parse(fresh(JSON.stringify({ n: 1 }))) as { body: string };
    env.body = JSON.stringify({ n: 2 });
    expect(verify(JSON.stringify(env)).ok).toBe(false);
  });

  test("tampered timestamp fails signature (ts is MAC-covered)", () => {
    const env = JSON.parse(fresh("{}")) as { ts: number };
    env.ts = NOW + 1;
    const verdict = verify(JSON.stringify(env));
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toBe("signature mismatch");
  });

  test("a bare (legacy, unsigned) event body is rejected", () => {
    const verdict = verify(JSON.stringify({ action: "created" }));
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toBe("unsupported envelope version");
  });

  test("non-JSON, wrong alg, bad ts, and missing fields fail with FIXED reasons (no interpolation)", () => {
    expect(verify("not json").ok).toBe(false);
    const hostile = "A".repeat(1024);
    const wrongV = verify(JSON.stringify({ v: hostile, alg: "hmac-sha256", ts: NOW, sig: "", body: "{}" }));
    if (!wrongV.ok) {
      expect(wrongV.reason).toBe("unsupported envelope version");
      expect(wrongV.reason).not.toContain(hostile.slice(0, 8));
    }
    const wrongAlg = verify(JSON.stringify({ v: 1, alg: hostile, ts: NOW, sig: "", body: "{}" }));
    if (!wrongAlg.ok) expect(wrongAlg.reason).toBe("unsupported alg");
    const badTs = verify(JSON.stringify({ v: 1, alg: "hmac-sha256", ts: "soon", sig: "", body: "{}" }));
    if (!badTs.ok) expect(badTs.reason).toBe("bad timestamp");
    expect(verify(JSON.stringify({ v: 1, alg: "hmac-sha256", ts: NOW })).ok).toBe(false);
  });

  test("malformed sig (non-hex / wrong length / trailing garbage) fails the format check", () => {
    for (const sig of ["abcd", "z".repeat(64), signBody(KEY, AUD, NOW, "{}") + "ff"]) {
      const verdict = verify(JSON.stringify({ v: 1, alg: "hmac-sha256", ts: NOW, sig, body: "{}" }));
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) expect(verdict.reason).toBe("sig malformed");
    }
  });

  test("failure reasons never contain signature or key material", () => {
    const verdict = verify(fresh("{}", "other-key"));
    if (!verdict.ok) {
      expect(verdict.reason).not.toContain(KEY);
      expect(verdict.reason).not.toContain(signBody("other-key", AUD, NOW, "{}"));
    }
  });
});
