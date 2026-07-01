/**
 * Retry a Linear API call through transient failures — rate limits and 5xx.
 *
 * Linear signals rate limiting NOT as HTTP 429/`Retry-After` but as an HTTP 400
 * whose GraphQL error carries `extensions.type` / code `RATELIMITED`, with reset
 * timing in `X-RateLimit-*-Reset` headers (UTC epoch ms). `@linear/sdk` surfaces
 * this as a `LinearError` (`.status` / `.type` / `.errors[].extensions`). We also
 * retry genuine transport hiccups (502/503/504, connection timeouts) — the
 * "upstream connect error / connection timeout" class seen on heavier queries.
 *
 * Backoff (Atlassian's quantified spec, retargeted at Linear's signal): exponential
 * — base 2s, ×2 per attempt — with ±30% jitter, capped per-sleep and at `retries`
 * attempts. Non-transient errors throw immediately. (spec §10 — rate-limit resilience.)
 *
 * Reset-header-aware sleeping is deliberately NOT attempted: a thrown LinearError
 * doesn't reliably carry response headers, so we rely on jittered exponential
 * backoff. Proactive throttling on `X-RateLimit-*-Remaining` is a follow-up.
 */
export interface RetryOptions {
  /** Max retries after the first attempt (default 4). */
  retries?: number;
  /** Base backoff in ms (default 2000). */
  baseMs?: number;
  /** Per-sleep cap in ms (default 30_000). */
  capMs?: number;
  /** Called before each retry sleep — defaults to a concise stderr notice. */
  onRetry?: (info: { attempt: number; delayMs: number; reason: string }) => void;
}

const TRANSIENT_STATUS = new Set([429, 500, 502, 503, 504]);

interface LinearErrorish {
  status?: number;
  type?: string;
  message?: string;
  errors?: Array<{ extensions?: { type?: string; code?: string } }>;
}

/** Decide whether an error is worth retrying, and label why (for the notice). */
export function classifyError(err: unknown): { transient: boolean; reason: string } {
  const e = (err ?? {}) as LinearErrorish;
  const msg = String(e.message ?? "");
  const codes = (e.errors ?? [])
    .flatMap((g) => [g?.extensions?.type, g?.extensions?.code])
    .filter((c): c is string => Boolean(c));
  const isRateLimited =
    codes.some((c) => /ratelimit/i.test(c)) ||
    /ratelimit/i.test(String(e.type ?? "")) ||
    /\bratelimited\b|too many requests|rate limit/i.test(msg);
  if (isRateLimited) return { transient: true, reason: "ratelimited" };
  if (e.status != null && TRANSIENT_STATUS.has(e.status))
    return { transient: true, reason: `http-${e.status}` };
  if (/timeout|ECONNRESET|ETIMEDOUT|EAI_AGAIN|upstream connect|temporarily/i.test(msg))
    return { transient: true, reason: "transport" };
  return { transient: false, reason: "non-transient" };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Wrap an async Linear call so transient failures retry with jittered exponential backoff. */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const retries = opts.retries ?? 4;
  const base = opts.baseMs ?? 2000;
  const cap = opts.capMs ?? 30_000;
  const onRetry =
    opts.onRetry ??
    ((info) =>
      process.stderr.write(
        `  [retry ${info.attempt}/${retries}] ${info.reason}; waiting ${info.delayMs}ms…\n`,
      ));

  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      const { transient, reason } = classifyError(err);
      if (!transient || attempt >= retries) throw err;
      attempt += 1;
      const backoff = Math.min(cap, base * 2 ** (attempt - 1));
      const delayMs = Math.round(backoff * (0.7 + Math.random() * 0.6)); // ±30% jitter
      onRetry({ attempt, delayMs, reason });
      await sleep(delayMs);
    }
  }
}
