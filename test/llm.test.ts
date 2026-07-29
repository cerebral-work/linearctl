import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { complete, LLMError, type ChatMessage, type FetchLike } from "../src/lib/llm.js";

/**
 * LLM gateway client tests (Track 3) — stubbed fetch, NO real gateway call.
 *
 * Covers: request shape POSTs to ${LLM_BASE_URL}/chat/completions with the
 * OpenAI payload; choices[0].message.content is parsed; 30s timeout → LLMError;
 * non-2xx → LLMError (no verbatim body echo); env-var override (LLM_BASE_URL,
 * LLM_MODEL); injectable fetchImpl (default-free, deterministic in tests).
 */

const DEFAULT_MESSAGES: ChatMessage[] = [
  { role: "system", content: "sys" },
  { role: "user", content: "hi" },
];

/** Build a fake fetch that records the call and returns a canned response. */
function fakeFetch(opts: {
  body?: unknown;
  status?: number;
  json?: unknown;
  text?: string;
}) {
  const calls: Array<{
    url: string;
    method: string;
    headers: Record<string, string>;
    body: string;
  }> = [];
  const fetchImpl = (async (url: string, init: RequestInit): Promise<Response> => {
    calls.push({
      url,
      method: init.method ?? "GET",
      headers: init.headers as Record<string, string>,
      body: init.body as string,
    });
    const status = opts.status ?? 200;
    if (opts.json !== undefined) {
      return new Response(JSON.stringify(opts.json), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(opts.text ?? "", { status });
  }) as FetchLike;
  return { fetchImpl, calls };
}

describe("complete() — request shape", () => {
  test("POSTs to ${LLM_BASE_URL}/chat/completions with the OpenAI payload", async () => {
    const { fetchImpl, calls } = fakeFetch({
      json: { choices: [{ message: { content: "hello back" } }] },
    });

    const out = await complete(DEFAULT_MESSAGES, {}, fetchImpl);

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("http://llm.llm.svc.cluster.local:4000/v1/chat/completions");
    expect(calls[0].method).toBe("POST");
    expect(calls[0].headers["Content-Type"]).toBe("application/json");

    const parsed = JSON.parse(calls[0].body);
    expect(parsed.model).toBe("glm-5.2");
    expect(parsed.messages).toEqual(DEFAULT_MESSAGES);
    expect(parsed.max_tokens).toBe(512);
    expect(parsed.temperature).toBe(0.3);
    expect(out).toBe("hello back");
  });

  test("passes through opts.model / maxTokens / temperature when provided", async () => {
    const { fetchImpl, calls } = fakeFetch({
      json: { choices: [{ message: { content: "x" } }] },
    });
    await complete(
      DEFAULT_MESSAGES,
      { model: "custom-model", maxTokens: 100, temperature: 0.7 },
      fetchImpl,
    );
    const parsed = JSON.parse(calls[0].body);
    expect(parsed.model).toBe("custom-model");
    expect(parsed.max_tokens).toBe(100);
    expect(parsed.temperature).toBe(0.7);
  });
});

describe("complete() — response parsing", () => {
  test("returns choices[0].message.content as a string", async () => {
    const { fetchImpl } = fakeFetch({
      json: {
        choices: [{ message: { content: "the answer is 42" }, finish_reason: "stop" }],
      },
    });
    expect(await complete(DEFAULT_MESSAGES, {}, fetchImpl)).toBe("the answer is 42");
  });

  test("throws LLMError when choices[0].message.content is missing", async () => {
    const { fetchImpl } = fakeFetch({ json: { choices: [{ message: {} }] } });
    await expect(complete(DEFAULT_MESSAGES, {}, fetchImpl)).rejects.toBeInstanceOf(LLMError);
  });

  test("throws LLMError when choices array is empty", async () => {
    const { fetchImpl } = fakeFetch({ json: { choices: [] } });
    await expect(complete(DEFAULT_MESSAGES, {}, fetchImpl)).rejects.toBeInstanceOf(LLMError);
  });

  test("throws LLMError when body is not valid JSON", async () => {
    const { fetchImpl } = fakeFetch({ text: "not-json{{" });
    await expect(complete(DEFAULT_MESSAGES, {}, fetchImpl)).rejects.toBeInstanceOf(LLMError);
  });
});

describe("complete() — error handling + timeout", () => {
  test("non-2xx HTTP → LLMError with the status, no verbatim body echo", async () => {
    const { fetchImpl } = fakeFetch({ status: 500, text: "internal gateway explosion" });
    try {
      await complete(DEFAULT_MESSAGES, {}, fetchImpl);
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(LLMError);
      const e = err as LLMError;
      expect(e.status).toBe(500);
      expect(e.message).toContain("500");
      // The sensitive response body must NOT be echoed in the error.
      expect(e.message).not.toContain("internal gateway explosion");
    }
  });

  test("403 forbidden → LLMError carries status 403", async () => {
    const { fetchImpl } = fakeFetch({ status: 403, text: "" });
    try {
      await complete(DEFAULT_MESSAGES, {}, fetchImpl);
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(LLMError);
      expect((err as LLMError).status).toBe(403);
    }
  });

  test("network failure → LLMError (not a raw TypeError)", async () => {
    const fetchImpl = (async (): Promise<Response> => {
      throw new TypeError("fetch failed: connect ECONNREFUSED");
    }) as unknown as FetchLike;
    await expect(complete(DEFAULT_MESSAGES, {}, fetchImpl)).rejects.toBeInstanceOf(LLMError);
  });

  test("an aborted fetch (30s timeout) surfaces as LLMError, not a raw AbortError", async () => {
    // The production 30s timer fires the AbortController, which a real fetch
    // surfaces as an AbortError. This test stubs the fetch to reject with
    // AbortError immediately — proving the AbortError → LLMError mapping
    // without waiting the real 30s wall clock.
    const fetchImpl = (async (): Promise<Response> => {
      const e = new Error("The operation was aborted");
      e.name = "AbortError";
      throw e;
    }) as unknown as FetchLike;
    try {
      await complete(DEFAULT_MESSAGES, {}, fetchImpl);
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(LLMError);
      expect((err as LLMError).message).toMatch(/timed out|abort/i);
    }
  });
});

describe("complete() — env-var override", () => {
  const origBaseUrl = process.env.LLM_BASE_URL;
  const origModel = process.env.LLM_MODEL;

  beforeEach(() => {
    delete process.env.LLM_BASE_URL;
    delete process.env.LLM_MODEL;
  });

  afterEach(() => {
    if (origBaseUrl === undefined) delete process.env.LLM_BASE_URL;
    else process.env.LLM_BASE_URL = origBaseUrl;
    if (origModel === undefined) delete process.env.LLM_MODEL;
    else process.env.LLM_MODEL = origModel;
  });

  test("LLM_BASE_URL overrides the gateway endpoint", async () => {
    process.env.LLM_BASE_URL = "https://custom-gateway.example.com/v1";
    const { fetchImpl, calls } = fakeFetch({
      json: { choices: [{ message: { content: "ok" } }] },
    });
    await complete(DEFAULT_MESSAGES, {}, fetchImpl);
    expect(calls[0].url).toBe("https://custom-gateway.example.com/v1/chat/completions");
  });

  test("LLM_MODEL overrides the default model when no opts.model given", async () => {
    process.env.LLM_MODEL = "llm/special-model";
    const { fetchImpl, calls } = fakeFetch({
      json: { choices: [{ message: { content: "ok" } }] },
    });
    await complete(DEFAULT_MESSAGES, {}, fetchImpl);
    const parsed = JSON.parse(calls[0].body);
    expect(parsed.model).toBe("llm/special-model");
  });

  test("opts.model takes precedence over LLM_MODEL env", async () => {
    process.env.LLM_MODEL = "llm/env-model";
    const { fetchImpl, calls } = fakeFetch({
      json: { choices: [{ message: { content: "ok" } }] },
    });
    await complete(DEFAULT_MESSAGES, { model: "llm/explicit" }, fetchImpl);
    const parsed = JSON.parse(calls[0].body);
    expect(parsed.model).toBe("llm/explicit");
  });
});

describe("complete() — auth + cluster config (PR #120)", () => {
  const origBaseUrl = process.env.LLM_BASE_URL;
  const origModel = process.env.LLM_MODEL;
  const origApiKey = process.env.LLM_API_KEY;

  beforeEach(() => {
    delete process.env.LLM_BASE_URL;
    delete process.env.LLM_MODEL;
    delete process.env.LLM_API_KEY;
  });

  afterEach(() => {
    if (origBaseUrl === undefined) delete process.env.LLM_BASE_URL;
    else process.env.LLM_BASE_URL = origBaseUrl;
    if (origModel === undefined) delete process.env.LLM_MODEL;
    else process.env.LLM_MODEL = origModel;
    if (origApiKey === undefined) delete process.env.LLM_API_KEY;
    else process.env.LLM_API_KEY = origApiKey;
  });

  test("default model is glm-5.2 (not llm/glm-5.2) — the cluster contract", async () => {
    const { fetchImpl, calls } = fakeFetch({
      json: { choices: [{ message: { content: "ok" } }] },
    });
    await complete(DEFAULT_MESSAGES, {}, fetchImpl);
    const parsed = JSON.parse(calls[0].body);
    expect(parsed.model).toBe("glm-5.2");
  });

  test("LLM_API_KEY adds an Authorization: Bearer <key> header", async () => {
    const key = "fake-llm-key-for-tests";
    process.env.LLM_API_KEY = key;
    const { fetchImpl, calls } = fakeFetch({
      json: { choices: [{ message: { content: "ok" } }] },
    });
    await complete(DEFAULT_MESSAGES, {}, fetchImpl);
    expect(calls[0].headers.Authorization).toBe(`Bearer ${key}`);
  });

  test("absent LLM_API_KEY sends NO Authorization header", async () => {
    const { fetchImpl, calls } = fakeFetch({
      json: { choices: [{ message: { content: "ok" } }] },
    });
    await complete(DEFAULT_MESSAGES, {}, fetchImpl);
    expect(calls[0].headers.Authorization).toBeUndefined();
  });

  test("default base URL is the in-cluster LiteLLM proxy (not tailnet)", async () => {
    const { fetchImpl, calls } = fakeFetch({
      json: { choices: [{ message: { content: "ok" } }] },
    });
    await complete(DEFAULT_MESSAGES, {}, fetchImpl);
    expect(calls[0].url).toBe("http://llm.llm.svc.cluster.local:4000/v1/chat/completions");
  });

  test("the API key is NEVER surfaced in an LLMError message", async () => {
    const secretKey = "fake-llm-key-surfaces-test";
    process.env.LLM_API_KEY = secretKey;
    const { fetchImpl } = fakeFetch({ status: 500, text: "boom" });
    try {
      await complete(DEFAULT_MESSAGES, {}, fetchImpl);
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(LLMError);
      expect((err as Error).message).not.toContain(secretKey);
    }
  });
});
