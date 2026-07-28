import { describe, expect, test } from "bun:test";
import type { LinearClient } from "@linear/sdk";
import {
  driveAgentLoop,
  parseLLMActivities,
  type AgentSessionEvent,
  type LLMCompleteFn,
} from "../src/core/watch.js";
import { LLMError } from "../src/lib/llm.js";

/**
 * LLM-backed `driveAgentLoop` + `parseLLMActivities` tests (Track 3).
 *
 * The LLM `complete` fn is injected (never a real gateway call). Covers:
 *   - parsed activities emitted in order via createAgentActivity
 *   - `action` type is REJECTED (first-slice guardrail — no mutations)
 *   - LLMError → falls back to a single `error` activity
 *   - non-LLMError throw → falls back to `error` activity
 *   - empty plan → fallback response
 *   - user prompt includes issueId + promptContext + reconstructed history
 *
 * `parseLLMActivities` is also tested directly (JSON shape, fence tolerance,
 * malformed input, unknown types).
 */

// ---- stubbed SDK helpers (mirrors watch.test.ts, kept local + minimal) ----

interface ActivityCall {
  agentSessionId: string;
  contentType: string;
  body?: string;
}

function createdEvent(opts?: {
  sessionId?: string;
  issueId?: string;
  promptContext?: string;
}): AgentSessionEvent {
  return {
    type: "AgentSessionEvent",
    action: "created",
    promptContext: opts?.promptContext ?? "<issue identifier=\"CER-1\"><title>x</title></issue>",
    agentSession: {
      id: opts?.sessionId ?? "session-1",
      issueId: opts?.issueId ?? "issue-1",
    },
  };
}

function stubClient(opts: {
  activities?: Array<{ id: string; content?: { type?: string; body?: string | null } }>;
}): { client: LinearClient; calls: ActivityCall[] } {
  const calls: ActivityCall[] = [];
  let counter = 0;
  const activities = opts.activities ?? [];
  const stub = {
    createAgentActivity: async (input: {
      agentSessionId: string;
      content: { type: string; body?: string };
    }) => {
      counter += 1;
      const id = `act-${counter}`;
      calls.push({
        agentSessionId: input.agentSessionId,
        contentType: input.content.type,
        body: input.content.body,
      });
      return {
        success: true,
        agentActivity: Promise.resolve({ id }),
        get agentActivityId() {
          return id;
        },
      };
    },
    agentSession: async (id: string) => ({
      id,
      activities: async () => ({ nodes: activities }),
    }),
  } as unknown as LinearClient;
  return { client: stub, calls };
}

// ---- parseLLMActivities ----

describe("parseLLMActivities", () => {
  test("parses a JSON array of { type, body } into an ordered plan", () => {
    const raw = JSON.stringify([
      { type: "thought", body: "step one" },
      { type: "elicitation", body: "which option?" },
      { type: "response", body: "final answer" },
    ]);
    const plans = parseLLMActivities(raw);
    expect(plans.map((p) => p.type)).toEqual(["thought", "elicitation", "response"]);
    expect(plans.map((p) => p.body)).toEqual(["step one", "which option?", "final answer"]);
  });

  test("tolerates a ```json fence wrapper (gateway JSON-mode-off case)", () => {
    const raw = "```json\n[{\"type\":\"response\",\"body\":\"fenced\"}]```";
    const plans = parseLLMActivities(raw);
    expect(plans).toEqual([{ type: "response", body: "fenced" }]);
  });

  test("tolerates a bare ``` fence wrapper", () => {
    const raw = "```\n[{\"type\":\"error\",\"body\":\"oops\"}]```";
    expect(parseLLMActivities(raw)).toEqual([{ type: "error", body: "oops" }]);
  });

  test("REJECTS an 'action' activity (first-slice guardrail — no mutations)", () => {
    const raw = JSON.stringify([
      { type: "response", body: "ok" },
      { type: "action", body: "merge the PR" },
    ]);
    expect(() => parseLLMActivities(raw)).toThrow(/action.*guardrails/i);
  });

  test("throws on an unknown activity type", () => {
    const raw = JSON.stringify([{ type: "mutation", body: "bad" }]);
    expect(() => parseLLMActivities(raw)).toThrow(/unknown activity type/);
  });

  test("throws when the LLM output is not valid JSON", () => {
    expect(() => parseLLMActivities("not json at all")).toThrow(/not valid JSON/);
  });

  test("throws when the JSON is not an array", () => {
    expect(() => parseLLMActivities('{"type":"response","body":"x"}')).toThrow(/expected a JSON array/);
  });

  test("throws when an entry is missing type or body", () => {
    expect(() => parseLLMActivities(JSON.stringify([{ type: "response" }]))).toThrow(/missing string type\/body/);
    expect(() => parseLLMActivities(JSON.stringify([{ body: "x" }]))).toThrow(/missing string type\/body/);
  });

  test("returns an empty array for an empty JSON array", () => {
    expect(parseLLMActivities("[]")).toEqual([]);
  });

  test("accepts all four first-slice types (thought, response, elicitation, error)", () => {
    const raw = JSON.stringify([
      { type: "thought", body: "a" },
      { type: "response", body: "b" },
      { type: "elicitation", body: "c" },
      { type: "error", body: "d" },
    ]);
    const plans = parseLLMActivities(raw);
    expect(plans).toHaveLength(4);
    expect(plans.map((p) => p.type)).toEqual(["thought", "response", "elicitation", "error"]);
  });
});

// ---- driveAgentLoop with an injected LLM client ----

describe("driveAgentLoop (LLM-backed)", () => {
  test("emits the LLM-parsed activities in order via createAgentActivity", async () => {
    const event = createdEvent({
      promptContext: "<issue identifier=\"CER-1\"><title>watch loop</title></issue>",
    });
    const { client, calls } = stubClient({
      activities: [{ id: "prior-1", content: { type: "prompt", body: "do the thing" } }],
    });

    const stubComplete: LLMCompleteFn = async () =>
      JSON.stringify([
        { type: "thought", body: "Analyzing the issue." },
        { type: "response", body: "I've reviewed the context." },
      ]);

    const id = await driveAgentLoop(client, event, stubComplete);

    expect(calls.map((c) => c.contentType)).toEqual(["thought", "response"]);
    expect(calls[0]?.body).toBe("Analyzing the issue.");
    expect(calls[1]?.body).toBe("I've reviewed the context.");
    // Returns the LAST activity's id.
    expect(id).toBe("act-2");
  });

  test("rejects an LLM-emitted 'action' → falls back to error activity", async () => {
    const event = createdEvent();
    const { client, calls } = stubClient({});

    const stubComplete: LLMCompleteFn = async () =>
      JSON.stringify([{ type: "action", body: "merge the PR" }]);

    await driveAgentLoop(client, event, stubComplete);

    // The `action` rejection surfaced as an error activity (no mutation emitted).
    expect(calls).toHaveLength(1);
    expect(calls[0].contentType).toBe("error");
    expect(calls[0].body).toContain("action");
    expect(calls[0].body).toContain("guardrails");
  });

  test("falls back to a single error activity when the LLM call throws LLMError", async () => {
    const event = createdEvent();
    const { client, calls } = stubClient({});

    const failingComplete: LLMCompleteFn = async () => {
      throw new LLMError("gateway timed out after 30000ms");
    };

    const id = await driveAgentLoop(client, event, failingComplete);

    expect(calls).toHaveLength(1);
    expect(calls[0].contentType).toBe("error");
    expect(calls[0].body).toContain("gateway timed out");
    expect(calls[0].body).toContain("Agent loop failed");
    expect(id).toBe("act-1");
  });

  test("falls back to error activity on a non-LLMError throw too", async () => {
    const event = createdEvent();
    const { client, calls } = stubClient({});
    const stubComplete: LLMCompleteFn = async () => {
      throw new Error("unexpected");
    };
    await driveAgentLoop(client, event, stubComplete);
    expect(calls[0].contentType).toBe("error");
    expect(calls[0].body).toContain("unexpected");
  });

  test("emits a fallback response when the LLM returns an empty plan", async () => {
    const event = createdEvent();
    const { client, calls } = stubClient({});
    const stubComplete: LLMCompleteFn = async () => "[]";
    await driveAgentLoop(client, event, stubComplete);
    expect(calls).toHaveLength(1);
    expect(calls[0].contentType).toBe("response");
    expect(calls[0].body).toContain("No actionable response");
  });

  test("builds a user prompt that includes issueId + promptContext + reconstructed history", async () => {
    const event = createdEvent({
      issueId: "issue-xyz",
      promptContext: "<issue><title>the thing</title></issue>",
    });
    const { client } = stubClient({
      activities: [{ id: "a1", content: { type: "thought", body: "prior thought" } }],
    });

    let captured: { messages: unknown[] } | undefined;
    const stubComplete: LLMCompleteFn = async (messages) => {
      captured = { messages };
      return "[]";
    };

    await driveAgentLoop(client, event, stubComplete);

    expect(captured).toBeDefined();
    const userMsg = (captured!.messages as Array<{ role: string; content: string }>).find(
      (m) => m.role === "user",
    );
    expect(userMsg).toBeDefined();
    expect(userMsg!.content).toContain("issue-xyz");
    expect(userMsg!.content).toContain("<issue><title>the thing</title></issue>");
    expect(userMsg!.content).toContain("thought: prior thought");
  });
});
