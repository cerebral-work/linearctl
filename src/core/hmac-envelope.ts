/**
 * HMAC message envelope for CF Queue bodies (operator ruling 2026-08-16).
 *
 * Cloudflare API-token scoping for Queues may be account-wide (per-queue
 * resource scoping unverified — see docs/runbooks/operator-daemon.md step 3),
 * so a producer token could push to any queue in the account — including
 * forging AgentSessionEvents into `linear-agent-events`. The ruled defense:
 * the webhook receiver signs every body at enqueue and the operator verifies
 * before processing, making queue-level write access insufficient to reach
 * the event loop.
 *
 * Envelope (v1):
 *   { "v": 1, "alg": "hmac-sha256", "ts": <epoch ms>, "sig": "<64 hex>", "body": "<raw JSON string>" }
 *
 * `sig` = HMAC-SHA256(key, "v1\n" + audience + "\n" + ts + "\n" + body) hex.
 * The MAC input binds:
 *   - the AUDIENCE (queue name) — domain separation, so an envelope signed
 *     for one queue never verifies on another queue sharing the key;
 *   - the TIMESTAMP — verifiers enforce a max age (default 10 min), bounding
 *     replay to a short window instead of forever;
 *   - the exact raw body string — parsed only after the signature verifies.
 *
 * Key: `LINEARCTL_QUEUE_HMAC_KEY` (OpenBao → ExternalSecret → env; shared
 * with the receiver). `LINEARCTL_QUEUE_HMAC_KEY_PREV` is accepted as a
 * fallback during rotation so a receiver/operator refresh skew doesn't
 * destroy legitimate events. Key values never appear in logs; verification
 * failures return a reason drawn from a FIXED set of strings — attacker-
 * supplied field values are never interpolated into reasons (log-injection
 * hygiene: a forged 128KB `v` field must not reach stderr).
 *
 * SCOPE LIMIT, stated plainly: replay within the freshness window is still
 * possible for a principal who can read the queue. v1's claim is "queue
 * write access alone cannot forge a NEW event, replay an OLD one beyond the
 * window, or cross queues" — no more. The `v` field is the upgrade path.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

/** Env var holding the shared signing key. */
export const QUEUE_HMAC_KEY_ENV = "LINEARCTL_QUEUE_HMAC_KEY";
/** Env var holding the previous key, accepted during rotation. */
export const QUEUE_HMAC_KEY_PREV_ENV = "LINEARCTL_QUEUE_HMAC_KEY_PREV";
/** The session-event queue's audience string (its queue name). */
export const AUDIENCE_AGENT_EVENTS = "linear-agent-events";
/** Default freshness window: 10 minutes. */
export const DEFAULT_MAX_AGE_MS = 10 * 60_000;

export type VerifyResult =
  | { ok: true; body: string }
  | { ok: false; reason: string };

/** A v1 HMAC-SHA256 signature: exactly 64 hex chars. Checked BEFORE hashing —
 * O(1) reject for malformed sigs, and it makes trailing-garbage sigs (which
 * `Buffer.from(s, "hex")` would silently truncate to a valid prefix) fail the
 * format check instead of accidentally verifying. */
const SIG_V1_RE = /^[0-9a-f]{64}$/i;

/** Compute the v1 signature (receiver + tests). */
export function signBody(key: string, audience: string, ts: number, body: string): string {
  return createHmac("sha256", key).update(`v1\n${audience}\n${ts}\n${body}`, "utf8").digest("hex");
}

/** Build a v1 envelope around a raw body string (receiver + tests). */
export function makeEnvelope(key: string, audience: string, body: string, ts: number): string {
  return JSON.stringify({ v: 1, alg: "hmac-sha256", ts, sig: signBody(key, audience, ts, body), body });
}

export interface VerifyOptions {
  /** Accepted during key rotation (tried after the current key). */
  prevKey?: string;
  /** Freshness window in ms (default {@link DEFAULT_MAX_AGE_MS}). */
  maxAgeMs?: number;
  /** Injectable clock for tests (epoch ms). */
  nowMs?: number;
}

/**
 * Verify a raw queue message against the shared key (and optionally the
 * previous key, during rotation). Returns the inner body on success; on
 * failure, a reason from a fixed set (no attacker-controlled interpolation,
 * no key/signature material). The sig format check runs before any hashing,
 * so a max-size forged body is rejected without paying an HMAC pass; digests
 * are compared with `timingSafeEqual` (both sides are always 32 bytes once
 * the format check passes — the length is public, the digest value is what
 * the constant-time comparison protects).
 */
export function verifyEnvelope(
  key: string,
  audience: string,
  raw: string,
  opts: VerifyOptions = {},
): VerifyResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "not JSON" };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { ok: false, reason: "not an object" };
  }
  const env = parsed as { v?: unknown; alg?: unknown; ts?: unknown; sig?: unknown; body?: unknown };
  if (env.v !== 1) return { ok: false, reason: "unsupported envelope version" };
  if (env.alg !== "hmac-sha256") return { ok: false, reason: "unsupported alg" };
  if (typeof env.ts !== "number" || !Number.isFinite(env.ts)) {
    return { ok: false, reason: "bad timestamp" };
  }
  if (typeof env.sig !== "string" || typeof env.body !== "string") {
    return { ok: false, reason: "missing sig/body" };
  }
  if (!SIG_V1_RE.test(env.sig)) {
    return { ok: false, reason: "sig malformed" };
  }
  // Signature before freshness: a stale-but-authentic message and a forged
  // one must be distinguishable in the logs (stale → rotation/latency
  // problems; mismatch → key desync or forgery).
  const actual = Buffer.from(env.sig, "hex");
  const matches = (k: string): boolean =>
    timingSafeEqual(actual, Buffer.from(signBody(k, audience, env.ts as number, env.body as string), "hex"));
  if (!matches(key) && !(opts.prevKey ? matches(opts.prevKey) : false)) {
    return { ok: false, reason: "signature mismatch" };
  }
  const nowMs = opts.nowMs ?? Date.now();
  const maxAgeMs = opts.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  if (Math.abs(nowMs - env.ts) > maxAgeMs) {
    return { ok: false, reason: "stale timestamp" };
  }
  return { ok: true, body: env.body };
}
