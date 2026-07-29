import { describe, expect, test } from "bun:test";
import type { LinearClient } from "@linear/sdk";
import {
  emitThought,
  moveToStartedIfDelegated,
  driveLoop,
  runEventLoop,
  type AgentSessionEvent,
  type LLMCompleteFn,
} from "../src/core/watch.js";

/**
 * Loop-driver contract tests for the `linearctl watch` full-loop fallback (CER-1149).
 *
 * Stubs the {@link LinearClient} SDK surface (no network) so the loop driver is
 * exercised against the verified AIG contract:
 *   - `emitThought` calls `createAgentActivity` with content type `thought` + body
 *   - `driveAgentLoop` (LLM-backed, Track 3) is tested in watch-llm.test.ts; here the loop-level invariants (thought-first SLA ordering, state moves) hold with a stubbed `complete` fn
 *   - `moveToStartedIfDelegated` queries team states + moves the issue when
 *     delegated + unstarted, and is a no-op when already started
 *   - `runEventLoop` emits thought FIRST then response (the 10s-SLA ordering)
 *
 * The webhook payload shape matches the `AgentSessionEventWebhookPayload`
 * schema verified against https://linear.app/developers/agent-interaction.
 */

// ---- payload builder (AIG schema) ----

/** Hand-built `created`-action AgentSessionEvent payload (issue-delegated session). */
function createdEvent(opts?: {
  sessionId?: string;
  issueId?: string;
  promptContext?: string;
}): AgentSessionEvent {
  return {
    type: "AgentSessionEvent",
    action: "created",
    promptContext: opts?.promptContext ?? "<issue identifier=\"CER-1149\"><title>watch loop</title></issue>",
    agentSession: {
      id: opts?.sessionId ?? "session-uuid-1",
      issueId: opts?.issueId ?? "issue-uuid-1",
    },
  };
}

// ---- stubbed SDK model helpers ----

interface StubState {
  id: string;
  name: string;
  type: string;
  position: number;
}

interface StubIssue {
  id: string;
  delegateId?: string;
  state?: { id: string; name: string; type: string };
  teamId: string;
  stateId?: string;
}

/** A record of every `createAgentActivity` call, in order (for ordering tests). */
interface ActivityCall {
  agentSessionId: string;
  contentType: string;
  body?: string;
}

/**
 * Build a stubbed LinearClient capturing agent-activity + issue/state calls.
 * Each `createAgentActivity` returns a fresh id (`act-N`) so ordering is verifiable.
 */
function stubClient(opts: {
  issue?: StubIssue;
  states?: StubState[];
  activities?: Array<{ id: string; contentType?: string; body?: string; content?: { type?: string; body?: string | null } }>;
}): { client: LinearClient; calls: ActivityCall[]; movedTo?: string; activityCounter: number } {
  const calls: ActivityCall[] = [];
  let activityCounter = 0;
  const issue = opts.issue ?? {
    id: "issue-uuid-1",
    delegateId: "agent-user-uuid",
    state: { id: "state-triage", name: "Triage", type: "triage" },
    teamId: "team-uuid-1",
  };
  const states =
    opts.states ?? [
      { id: "state-inprogress", name: "In Progress", type: "started", position: 10 },
      { id: "state-review", name: "In Review", type: "started", position: 20 },
    ];
  const activities = opts.activities ?? [];
  let movedTo: string | undefined;

  const stub = {
    createAgentActivity: async (input: {
      agentSessionId: string;
      content: { type: string; body?: string };
    }) => {
      activityCounter += 1;
      const id = `act-${activityCounter}`;
      calls.push({
        agentSessionId: input.agentSessionId,
        contentType: input.content.type,
        body: input.content.body,
      });
      return {
        success: true,
        lastSyncId: activityCounter,
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
    issue: async (id: string) => ({
      id,
      get delegateId() {
        return issue.delegateId;
      },
      get stateId() {
        return issue.state?.id;
      },
      state: Promise.resolve(issue.state ? { ...issue.state } : undefined),
      team: Promise.resolve({
        id: issue.teamId,
        states: async () => ({ nodes: states.slice() }),
      }),
      update: async (input: { stateId?: string }) => {
        if (input.stateId) movedTo = input.stateId;
        issue.state = states.find((s) => s.id === input.stateId) ?? issue.state;
        return { success: true, issue: Promise.resolve({ id }) };
      },
    }),
  } as unknown as LinearClient;

  return { client: stub, calls, activityCounter, get movedTo() { return movedTo; } };
}

/** A stub LLM `complete` fn that returns a single response activity. No real gateway. */
const stubComplete: LLMCompleteFn = async () =>
  JSON.stringify([{ type: "response", body: "stubbed LLM response" }]);

/** A stub LLM `complete` fn that emits a thought then a response (ordering test). */
const stubCompleteThoughtThenResponse: LLMCompleteFn = async () =>
  JSON.stringify([
    { type: "thought", body: "supplementary thought after SLA heartbeat" },
    { type: "response", body: "stubbed LLM response" },
  ]);

// ---- emitThought ----

describe("emitThought", () => {
  test("calls createAgentActivity with content type 'thought' + the body, returns the activity id", async () => {
    const { client, calls } = stubClient({});
    const id = await emitThought(client, "session-1", "thinking about it");
    expect(id).toBe("act-1");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      agentSessionId: "session-1",
      contentType: "thought",
      body: "thinking about it",
    });
  });

  test("throws when the SDK reports success=false", async () => {
    const client = {
      createAgentActivity: async () => ({
        success: false,
        agentActivity: Promise.resolve({ id: "x" }),
        get agentActivityId() {
          return "x";
        },
      }),
    } as unknown as LinearClient;
    await expect(emitThought(client, "session-1", "b")).rejects.toThrow(/did not succeed/);
  });
});


// ---- moveToStartedIfDelegated ----

describe("moveToStartedIfDelegated", () => {
  test("moves the issue to the lowest-position started state when delegated + unstarted", async () => {
    const event = createdEvent();
    const stub = stubClient({
      issue: {
        id: "issue-uuid-1",
        delegateId: "agent-user-uuid",
        state: { id: "state-triage", name: "Triage", type: "triage" },
        teamId: "team-1",
      },
      states: [
        { id: "state-review", name: "In Review", type: "started", position: 20 },
        { id: "state-inprogress", name: "In Progress", type: "started", position: 10 },
      ],
    });
    const res = await moveToStartedIfDelegated(stub.client, event);
    expect(res).toBe("state-inprogress"); // lowest position
    expect(stub.movedTo).toBe("state-inprogress");
  });

  test("is a no-op (null) when the issue is already started", async () => {
    const event = createdEvent();
    const stub = stubClient({
      issue: {
        id: "issue-uuid-1",
        delegateId: "agent-user-uuid",
        state: { id: "state-inprogress", name: "In Progress", type: "started" },
        teamId: "team-1",
      },
    });
    const res = await moveToStartedIfDelegated(stub.client, event);
    expect(res).toBeNull();
    expect(stub.movedTo).toBeUndefined();
  });

  test("is a no-op (null) when the issue is completed", async () => {
    const event = createdEvent();
    const stub = stubClient({
      issue: {
        id: "issue-uuid-1",
        delegateId: "agent-user-uuid",
        state: { id: "state-done", name: "Done", type: "completed" },
        teamId: "team-1",
      },
    });
    expect(await moveToStartedIfDelegated(stub.client, event)).toBeNull();
    expect(stub.movedTo).toBeUndefined();
  });

  test("is a no-op (null) when the issue is canceled", async () => {
    const event = createdEvent();
    const { client } = stubClient({
      issue: {
        id: "issue-uuid-1",
        delegateId: "agent-user-uuid",
        state: { id: "state-canceled", name: "Canceled", type: "canceled" },
        teamId: "team-1",
      },
    });
    expect(await moveToStartedIfDelegated(client, event)).toBeNull();
  });

  test("is a no-op (null) when the issue has no delegate (not delegated)", async () => {
    const event = createdEvent();
    const stub = stubClient({
      issue: {
        id: "issue-uuid-1",
        // no delegateId
        state: { id: "state-triage", name: "Triage", type: "triage" },
        teamId: "team-1",
      },
    });
    expect(await moveToStartedIfDelegated(stub.client, event)).toBeNull();
    expect(stub.movedTo).toBeUndefined();
  });

  test("is a no-op (null) when the session has no issueId (direct chat)", async () => {
    const event: AgentSessionEvent = {
      type: "AgentSessionEvent",
      action: "created",
      promptContext: "ctx",
      agentSession: { id: "sess-direct" }, // no issueId
    };
    const { client } = stubClient({});
    expect(await moveToStartedIfDelegated(client, event)).toBeNull();
  });

  test("throws when no started workflow state exists for the team", async () => {
    const event = createdEvent();
    const { client } = stubClient({
      issue: {
        id: "issue-uuid-1",
        delegateId: "agent-user-uuid",
        state: { id: "state-triage", name: "Triage", type: "triage" },
        teamId: "team-1",
      },
      states: [], // no started states
    });
    await expect(moveToStartedIfDelegated(client, event)).rejects.toThrow(/no started workflow state/);
  });
});

// ---- driveLoop: the thought-first ordering invariant ----

describe("driveLoop", () => {
  test("emits thought FIRST then response — the 10s-SLA ordering invariant", async () => {
    const event = createdEvent();
    // Custom stub where createAgentActivity records order AND we gate the
    // issue/states so all three legs of the loop run.
    const order: string[] = [];
    let counter = 0;
    const client = {
      createAgentActivity: async (input: {
        agentSessionId: string;
        content: { type: string };
      }) => {
        counter += 1;
        order.push(input.content.type);
        return {
          success: true,
          agentActivity: Promise.resolve({ id: `act-${counter}` }),
          get agentActivityId() {
            return `act-${counter}`;
          },
        };
      },
      agentSession: async (id: string) => ({
        id,
        activities: async () => ({ nodes: [] }),
      }),
      issue: async (id: string) => ({
        id,
        get delegateId() {
          return "agent-user-uuid";
        },
        get stateId() {
          return "state-triage";
        },
        state: Promise.resolve({ id: "state-triage", name: "Triage", type: "triage" }),
        team: Promise.resolve({
          id: "team-1",
          states: async () => ({
            nodes: [{ id: "state-inprogress", name: "In Progress", type: "started", position: 10 }],
          }),
        }),
        update: async (input: { stateId?: string }) => ({
          success: true,
          issue: Promise.resolve({ id }),
        }),
      }),
    } as unknown as LinearClient;

    const result = await driveLoop(client, event, stubComplete);

    expect(order).toEqual(["thought", "response"]);
    expect(result.thoughtId).toBe("act-1");
    expect(result.responseId).toBe("act-2");
    expect(result.movedToStateId).toBe("state-inprogress");
  });

  test("returns thought + response ids even when the issue already started (no move)", async () => {
    const event = createdEvent();
    const { client, calls } = stubClient({
      issue: {
        id: "issue-uuid-1",
        delegateId: "agent-user-uuid",
        state: { id: "state-inprogress", name: "In Progress", type: "started" },
        teamId: "team-1",
      },
    });
    const result = await driveLoop(client, event, stubComplete);
    expect(result.thoughtId).toBe("act-1");
    expect(result.responseId).toBe("act-2");
    expect(result.movedToStateId).toBeNull();
    expect(calls.map((c) => c.contentType)).toEqual(["thought", "response"]);
  });

  test("the SLA emitThought fires BEFORE the LLM call (load-bearing ordering)", async () => {
    // The 10s-SA heartbeat (emitThought) MUST precede the LLM call so the
    // session is never marked unresponsive while the gateway is still thinking.
    // We gate the LLM stub to only resolve once it has been invoked, and
    // capture the activity-order at the moment the LLM call starts.
    const event = createdEvent();
    const orderAtLlmCall: string[] = [];
    const { client, calls } = stubClient({
      issue: {
        id: "issue-uuid-1",
        delegateId: "agent-user-uuid",
        state: { id: "state-inprogress", name: "In Progress", type: "started" },
        teamId: "team-1",
      },
    });
    const gatedComplete: LLMCompleteFn = async () => {
      // Snapshot the activities emitted SO FAR — if emitThought ran first,
      // the `thought` is already recorded here.
      orderAtLlmCall.push(...calls.map((c) => c.contentType));
      return JSON.stringify([{ type: "response", body: "after-thought" }]);
    };

    await driveLoop(client, event, gatedComplete);

    // At the moment the LLM was called, the `thought` heartbeat was already emitted.
    expect(orderAtLlmCall).toEqual(["thought"]);
    // Full order: thought → response.
    expect(calls.map((c) => c.contentType)).toEqual(["thought", "response"]);
  });

  test("the LLM's supplementary thought is emitted AFTER the SLA heartbeat, not before", async () => {
    // When the LLM itself emits a `thought`, that thought is SUPPLEMENTARY —
    // it lands after the SLA emitThought, never replacing it.
    const event = createdEvent();
    const { client, calls } = stubClient({
      issue: {
        id: "issue-uuid-1",
        delegateId: "agent-user-uuid",
        state: { id: "state-inprogress", name: "In Progress", type: "started" },
        teamId: "team-1",
      },
    });

    await driveLoop(client, event, stubCompleteThoughtThenResponse);

    // thought (SLA) → thought (supplementary) → response
    expect(calls.map((c) => c.contentType)).toEqual(["thought", "thought", "response"]);
  });
});

// ---- runEventLoop: token wiring ----

describe("runEventLoop", () => {
  test("builds the OAuth client from a token then drives the loop (thought-first)", async () => {
    const event = createdEvent();
    let builtWithToken: string | undefined;
    const { client, calls } = stubClient({
      issue: {
        id: "issue-uuid-1",
        delegateId: "agent-user-uuid",
        state: { id: "state-inprogress", name: "In Progress", type: "started" },
        teamId: "team-1",
      },
    });

    const result = await runEventLoop(event, "opaque-minted-token", stubComplete, (token) => {
      builtWithToken = token;
      return client;
    });
    expect(builtWithToken).toBe("opaque-minted-token");
    expect(result.thoughtId).toBe("act-1");
    expect(result.responseId).toBe("act-2");
    expect(result.movedToStateId).toBeNull();
    expect(calls.map((c) => c.contentType)).toEqual(["thought", "response"]);
  });
});

// ---- tryDelegate: operator-socket delegation + fallback seam ----

import { tryDelegate } from "../src/commands/watch.js";
import type { EventLoopResult } from "../src/core/watch.js";

describe("tryDelegate", () => {
  test("returns the result when the operator responds 200", async () => {
    const expected: EventLoopResult = {
      thoughtId: "delegated-thought",
      responseId: "delegated-response",
      movedToStateId: "delegated-state",
    };
    const result = await tryDelegate(
      JSON.stringify({ action: "created" }),
      "/tmp/test-operator.sock",
      () => ({
        request: async () => ({
          status: 200,
          headers: {},
          body: JSON.stringify(expected),
        }),
      }),
    );
    expect(result).toEqual(expected);
  });

  test("returns null when the client factory cannot create a socket client", async () => {
    const result = await tryDelegate(
      JSON.stringify({ action: "created" }),
      "/tmp/test-operator.sock",
      () => {
        throw new Error("client setup failed");
      },
    );
    expect(result).toBeNull();
  });

  test("returns null (fallback) when the operator is unreachable (ECONNREFUSED)", async () => {
    const result = await tryDelegate(
      JSON.stringify({ action: "created" }),
      "/tmp/test-operator.sock",
      () => ({
        request: async () => {
          throw new Error("connect ECONNREFUSED");
        },
      }),
    );
    expect(result).toBeNull();
  });

  test("returns null when the operator responds non-200 (unhealthy)", async () => {
    const result = await tryDelegate(
      JSON.stringify({ action: "created" }),
      "/tmp/test-operator.sock",
      () => ({
        request: async () => ({ status: 500, headers: {}, body: "internal error" }),
      }),
    );
    expect(result).toBeNull();
  });

  test("returns null when the operator responds 200 without a body", async () => {
    const result = await tryDelegate(
      JSON.stringify({ action: "created" }),
      "/tmp/test-operator.sock",
      () => ({
        request: async () => ({ status: 200, headers: {}, body: "" }),
      }),
    );
    expect(result).toBeNull();
  });

  test("returns null when the operator response body is not valid JSON", async () => {
    const result = await tryDelegate(
      JSON.stringify({ action: "created" }),
      "/tmp/test-operator.sock",
      () => ({
        request: async () => ({ status: 200, headers: {}, body: "not-json{{" }),
      }),
    );
    expect(result).toBeNull();
  });
});
