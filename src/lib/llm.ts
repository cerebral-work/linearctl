/**
 * LLM gateway client (Track 3) — OpenAI-compatible chat completion over the
 * estate LLM gateway.
 *
 * Cluster deployment (PR #120): the gateway is the in-cluster LiteLLM proxy at
 * `http://llm.llm.svc.cluster.local:4000/v1`, reachable over the pod network
 * (no tailnet dependency). It exposes an OpenAI-compatible
 * `/chat/completions` endpoint, so this client uses a plain `fetch` — no SDK
 * dependency (respects the minimal-deps doctrine, `docs/decisions.md` ADR-0001).
 *
 * Config (env, with defaults):
 *   - `LLM_BASE_URL` — gateway base, default `http://llm.llm.svc.cluster.local:4000/v1`
 *     (the chart sets this via a Deployment env ref; local dev overrides to
 *     `http://llm/v1` for the tailnet gateway).
 *   - `LLM_MODEL`     — model alias, default `glm-5.2`
 *   - `LLM_API_KEY`   — optional. When set, adds `Authorization: Bearer <key>`.
 *     The key is held only for the request; it is NEVER logged, echoed, or
 *     surfaced in an `LLMError` message (per estate secret rules).
 *
 * Per estate secret rules, this module NEVER logs prompts or responses verbatim
 * — issue descriptions carried in `promptContext` may contain sensitive text.
 */

/** A single chat message in the OpenAI `messages` array shape. */
export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** Options for {@link complete}. */
export interface CompleteOptions {
  /** Model alias to route through the LiteLLM gateway. Default `glm-5.2`. */
  model?: string;
  /** Max tokens for the completion (the AIG slice budgets ~512). */
  maxTokens?: number;
  /** Sampling temperature (deterministic-leaning, ~0.3 for the agent loop). */
  temperature?: number;
}

/**
 * Error raised when the LLM gateway call fails (non-2xx, bad JSON, network, or
 * 30s timeout). Carries a reason; the daemon's `driveAgentLoop` catches this
 * and falls back to an `error` activity so the AIG session never wedges.
 */
export class LLMError extends Error {
  constructor(
    message: string,
    /** HTTP status if available (non-2xx responses), else `undefined`. */
    readonly status?: number,
  ) {
    super(message);
    this.name = "LLMError";
  }
}

/** Fetch-like signature, mirroring `src/lib/oauth.ts`'s `FetchLike` for injection. */
export type FetchLike = typeof fetch;

/** Default gateway base — in-cluster LiteLLM proxy (PR #120 chart value). */
const DEFAULT_LLM_BASE_URL = "http://llm.llm.svc.cluster.local:4000/v1";
/** Default model alias routed through the LiteLLM gateway. */
const DEFAULT_LLM_MODEL = "glm-5.2";
/** Hard timeout for the gateway call — the daemon must not wedge the session. */
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Request a chat completion from the LLM gateway.
 *
 * POSTs an OpenAI-compatible payload to `${LLM_BASE_URL}/chat/completions` and
 * returns the `choices[0].message.content` string. Enforces a 30s hard timeout
 * via `AbortController`; on timeout (or any failure) throws {@link LLMError} so
 * the caller can fall back to an `error` activity without propagating a wedge.
 *
 * @param fetchImpl optional injected fetch (tests stub this; never a real call)
 */
export async function complete(
  messages: ChatMessage[],
  opts: CompleteOptions = {},
  fetchImpl: FetchLike = fetch,
): Promise<string> {
  const baseUrl = process.env.LLM_BASE_URL ?? DEFAULT_LLM_BASE_URL;
  const url = `${baseUrl}/chat/completions`;
  const body = {
    model: opts.model ?? process.env.LLM_MODEL ?? DEFAULT_LLM_MODEL,
    messages,
    max_tokens: opts.maxTokens ?? 512,
    temperature: opts.temperature ?? 0.3,
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  // Optional `LLM_API_KEY`: when set, add a Bearer header. The key is held
  // only for this request and is NEVER surfaced in an LLMError message.
  const apiKey = process.env.LLM_API_KEY;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    // AbortController abort surfaces as a DOMException named "AbortError".
    if (err instanceof Error && err.name === "AbortError") {
      throw new LLMError(`LLM gateway timed out after ${REQUEST_TIMEOUT_MS}ms`);
    }
    throw new LLMError(
      `LLM gateway request failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  clearTimeout(timer);

  if (!res.ok) {
    // Do NOT log the body verbatim (may echo sensitive prompt content back).
    throw new LLMError(`LLM gateway returned HTTP ${res.status}`, res.status);
  }

  let parsed: unknown;
  try {
    parsed = await res.json();
  } catch {
    throw new LLMError("LLM gateway returned non-JSON body");
  }

  const content = extractContent(parsed);
  if (content === null) {
    throw new LLMError("LLM gateway response missing choices[0].message.content");
  }
  return content;
}

/**
 * Safely pull `choices[0].message.content` out of a parsed OpenAI response.
 * Structural guards — never trusts the shape blindly.
 */
function extractContent(parsed: unknown): string | null {
  if (!parsed || typeof parsed !== "object") return null;
  const p = parsed as Record<string, unknown>;
  const choices = p.choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const first = choices[0];
  if (!first || typeof first !== "object") return null;
  const message = (first as Record<string, unknown>).message;
  if (!message || typeof message !== "object") return null;
  const content = (message as Record<string, unknown>).content;
  return typeof content === "string" ? content : null;
}
