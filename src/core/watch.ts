/**
 * Agent-session loop driver (CER-1149).
 *
 * The full-loop fallback path the `linearctl watch` verb and the (future)
 * `linearctl operator` daemon both call. Pure domain logic over the
 * {@link LinearClient} SDK surface — no I/O of its own (token minting, payload
 * parsing, and output formatting live in the command layer).
 *
 * AIG contract (verified 2026-07-28 against
 * https://linear.app/developers/agent-interaction + agent-best-practices):
 *
 *   - `created` webhook → the agent MUST emit a `thought` activity within 10s
 *     or the session is marked unresponsive. This driver emits `thought`
 *     FIRST, before any reasoning or I/O, so the 10s SLA holds.
 *   - The webhook receiver must return 200 within 5s (the caller's concern;
 *     this library does not answer HTTP).
 *   - 30-min activity window before a session goes stale (recoverable by any
 *     subsequent activity).
 *   - 5 activity content types an agent may emit: `thought`, `action` (±result),
 *     `elicitation`, `response`, `error`. (`prompt` is user-only.)
 *   - `promptContext` (on `created` events) is a formatted XML string carrying
 *     issue details, comments, and guidance.
 *   - Delegated issue in a non-`started`/`completed`/`canceled` state must be
 *     moved to the first `started` workflow state (lowest `position`).
 */

import type { AgentActivity, LinearClient } from "@linear/sdk";
import { makeOAuthClient } from "../client.js";
import { complete as llmComplete, LLMError, type ChatMessage, type CompleteOptions } from "../lib/llm.js";

/** Workflow-state types that count as "started" (no state move needed). */
const STARTED_TYPES: Record<string, true> = {
  started: true,
  completed: true,
  canceled: true,
};

/**
 * The parsed `AgentSessionEvent` webhook payload — the JSON Linear POSTs to the
 * agent's webhook URL (action `created` or `prompted`). A structural
 * interface, NOT the SDK's `AgentSessionEventWebhookPayload` class: webhook
 * payloads arrive as parsed JSON, so the class constructor is never invoked.
 * Mirrors the verified AIG schema; only the fields this driver needs.
 *
 * @see https://linear.app/developers/agent-interaction (AgentSessionEventWebhookPayload)
 */
export interface AgentSessionEvent {
  /** Resource type — always `"AgentSessionEvent"`. */
  type: string;
  /** `"created"` (new session via mention/delegation) or `"prompted"` (user follow-up). */
  action: string;
  /** Formatted XML context (issue/comment/guidance). Present on `created` events only. */
  promptContext?: string | null;
  /** The agent session the event belongs to. */
  agentSession: {
    id: string;
    /** Issue the session is associated with (present for issue-delegated sessions). */
    issueId?: string | null;
    [k: string]: unknown;
  };
  /** On `prompted`, the new user message lives here. */
  agentActivity?: { body?: string | null; [k: string]: unknown } | null;
  [k: string]: unknown;
}

/** Pull the agent-session id out of an event, throwing a clear error if absent. */
function sessionOf(event: AgentSessionEvent): string {
  const id = event.agentSession?.id;
  if (!id) {
    throw new Error("AgentSessionEvent payload is missing agentSession.id");
  }
  return id;
}

/**
 * Emit a `thought` activity — the 10s-SLA heartbeat.
 *
 * LOAD-BEARING: this is the FIRST activity a `created` handler emits. Linear
 * marks a new session unresponsive if no activity lands within 10s of the
 * `created` event, so callers MUST invoke this before any reasoning or I/O.
 * The body is a short acknowledgement that the prompt was received.
 *
 * @returns the created activity's node id (for caller output / ordering tests).
 */
export async function emitThought(
  client: LinearClient,
  agentSessionId: string,
  body: string,
): Promise<string> {
  const payload = await client.createAgentActivity({
    agentSessionId,
    content: { type: "thought", body },
  });
  if (!payload?.success) {
    throw new Error(
      `createAgentActivity(thought) did not succeed for session ${agentSessionId}`,
    );
  }
  const activity = await payload.agentActivity;
  if (!activity?.id) {
    throw new Error(
      `createAgentActivity(thought) returned no activity id for session ${agentSessionId}`,
    );
  }
  return activity.id;
}

/**
 * Drive one agent loop iteration over the session history + prompt context.
 *
 * Calls the LLM gateway (`src/lib/llm.ts`) to reason over the issue context +
 * reconstructed activity history, then parses the structured output into an
 * ordered list of activities and emits each via `createAgentActivity`.
 *
 * First slice (Track 3): the LLM may emit `thought`, `response`, `elicitation`,
 * and `error` activities ONLY — `action` activities carry Linear mutations and
 * require the D2 guardrail gate (Track 1 Phase 3), so they are rejected here
 * until guardrails land. If the LLM call itself fails (timeout/non-2xx/bad
 * JSON), the loop falls back to a single `error` activity so the AIG session
 * never wedges (the `error` content type exists for exactly this per the AIG
 * contract, see header line 19-20).
 *
 * The `emitThought` BEFORE this call (in `driveLoop`, line ~244) is
 * load-bearing for the 10s SLA — the LLM's emitted `thought`, if any, is a
 * SUPPLEMENTARY thought, not the SLA heartbeat.
 *
 * @param completeFn injected LLM client (tests stub this; production uses
 *   the real gateway client from `src/lib/llm.ts`).
 * @returns the last created activity's node id.
 */
export async function driveAgentLoop(
  client: LinearClient,
  event: AgentSessionEvent,
  completeFn: LLMCompleteFn = llmComplete,
): Promise<string> {
  const sessionId = sessionOf(event);

  // Fetch the session to read its activities (conversation history). The
  // best-practices doc: reconstruct history from Agent Activities, not
  // editable comments.
  const session = await client.agentSession(sessionId);
  const activities = await session.activities();

  const messages: ChatMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    {
      role: "user",
      content: buildUserPrompt(event, activities.nodes),
    },
  ];

  let plans: ActivityPlan[];
  try {
    const raw = await completeFn(messages, LLM_OPTS);
    plans = parseLLMActivities(raw);
  } catch (err) {
    // LLM gateway failure (timeout / non-2xx / bad JSON) — the AIG contract
    // defines the `error` content type for exactly this. Emit a single error
    // activity so the session recovers rather than wedging.
    const reason = err instanceof LLMError ? err.message : (err instanceof Error ? err.message : String(err));
    plans = [{ type: "error", body: `Agent loop failed: ${reason}` }];
  }

  // Fallback: if the LLM returned an empty plan, emit a minimal response so
  // the session always gets a reply (the daemon acks regardless — this is a
  // UX cushion, not a correctness guard).
  if (plans.length === 0) {
    plans = [{ type: "response", body: "No actionable response was generated." }];
  }

  let lastId = "";
  for (const plan of plans) {
    lastId = await emitActivity(client, sessionId, plan);
  }
  return lastId;
}

/** Injected LLM completion signature — tests stub this; no real gateway. */
export type LLMCompleteFn = (
  messages: ChatMessage[],
  opts: CompleteOptions,
) => Promise<string>;

/**
 * First-slice activity types the LLM may emit. `action` (which carries Linear
 * mutations) is excluded until the D2 guardrail gate (Track 1 Phase 3) lands.
 */
export type ActivityType = "thought" | "response" | "elicitation" | "error";

/** A parsed activity the LLM wants the loop to emit, in order. */
export interface ActivityPlan {
  type: ActivityType;
  body: string;
}

/** The structured type a forbidden `action` activity would carry. */
const ACTION_TYPE = "action";

/** Rejected-activity-type message — constant, so the test can match on it. */
const ACTION_REJECTED_MSG =
  "parseLLMActivities rejected an 'action' activity: guardrails not yet in place (Track 1 Phase 3)";

/**
 * Parse structured LLM output into an ordered list of activities to emit.
 *
 * Accepts a JSON array of `{ type, body }` objects. The first slice restricts
 * `type` to `thought` | `response` | `elicitation` | `error` — an `action` type
 * is REJECTED (thrown), because actions carry Linear mutations and the D2
 * guardrail gate from Track 1 Phase 3 is not yet in place.
 *
 * Tolerant of a leading/trailing code-fence wrapper (```json … ```) the gateway
 * may add when its JSON mode is off; extracts the inner JSON array.
 */
export function parseLLMActivities(raw: string): ActivityPlan[] {
  const json = stripFence(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error(`parseLLMActivities: LLM output is not valid JSON: ${preview(raw)}`);
  }

  if (!Array.isArray(parsed)) {
    throw new Error(`parseLLMActivities: expected a JSON array, got ${preview(json)}`);
  }

  const plans: ActivityPlan[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object") {
      throw new Error(`parseLLMActivities: activity entry is not an object: ${preview(json)}`);
    }
    const obj = item as Record<string, unknown>;
    const type = obj.type;
    const body = obj.body;
    if (typeof type !== "string" || typeof body !== "string") {
      throw new Error(`parseLLMActivities: activity missing string type/body: ${preview(json)}`);
    }
    if (type === ACTION_TYPE) {
      throw new Error(ACTION_REJECTED_MSG);
    }
    if (!isValidActivityType(type)) {
      throw new Error(`parseLLMActivities: unknown activity type '${type}' (allowed: thought, response, elicitation, error)`);
    }
    plans.push({ type: type as ActivityType, body });
  }
  return plans;
}

/** The LLM gateway call options for the agent loop — deterministic-leaning. */
const LLM_OPTS: CompleteOptions = { maxTokens: 512, temperature: 0.3 };

/**
 * System prompt defining the 5 AIG activity types + the first-slice guardrail
 * (no `action`). Constrains the model to emit a JSON array of activities.
 */
const SYSTEM_PROMPT =
  "You are the linearctl agent operating inside Linear's Agent Interaction Gateway (AIG). " +
  "You receive issue context as XML and the prior activity history. Reason over the context and " +
  "decide what activities to emit next.\n\n" +
  "Linear AIG defines 5 activity content types an agent may emit:\n" +
  "  - thought:      a short reasoning step or plan.\n" +
  "  - action:       a Linear mutation, with an optional result. (In this FIRST SLICE you MUST NOT emit 'action' — guardrails are not yet in place.)\n" +
  "  - elicitation:  ask the user a clarifying question.\n" +
  "  - response:     a final answer to the user.\n" +
  "  - error:        report a failure so the session can recover.\n" +
  "('prompt' is user-only; never emit it.)\n\n" +
  "OUTPUT FORMAT: respond with ONLY a JSON array of objects, each {\"type\": \"...\", \"body\": \"...\"}. " +
  "Do not include markdown, prose, or any text outside the JSON array.\n" +
  "First-slice constraint: type MUST be one of thought, response, elicitation, or error. Never 'action'.\n" +
  "Example: [{\"type\":\"response\",\"body\":\"I've reviewed the issue.\"}]";

/**
 * Build the user message: the issue XML (`promptContext`) + reconstructed
 * activity history. The best-practices doc says reconstruct history from
 * Agent Activities, not editable comments.
 */
function buildUserPrompt(
  event: AgentSessionEvent,
  activities: AgentActivity[],
): string {
  const issueId = event.agentSession?.issueId ?? "unknown";
  const context = event.promptContext ?? "(no promptContext — direct chat / prompted follow-up)";
  const history =
    activities.length === 0
      ? "(no prior activities — first turn)"
      : activities
          .map((a, i) => `[${i}] ${describeActivity(a)}`)
          .join("\n");
  const followUp = event.agentActivity?.body
    ? `\n\nNew user message: ${event.agentActivity.body}`
    : "";
  return (
    `Issue: ${issueId}\n\n` +
    `Issue context (XML):\n${context}\n\n` +
    `Prior activity history (reconstructed):\n${history}${followUp}`
  );
}

/**
 * Render one SDK {@link AgentActivity} as a single history line for the prompt.
 * `content` is a discriminated union: `.type` is always present; `.body` exists
 * on every variant except `action` (which carries `action`/`parameter`/`result`
 * instead). We read defensively so a thin/partial payload never breaks the loop.
 */
function describeActivity(a: AgentActivity): string {
  const c = a.content as { type?: string; body?: string | null; action?: unknown; result?: unknown } | null;
  const type = c?.type ?? "unknown";
  const body = typeof c?.body === "string" ? c.body : JSON.stringify(c?.action ?? c?.result ?? "");
  return `${type}: ${body}`;
}

/**
 * Emit one parsed activity plan as a `createAgentActivity` call. Returns the
 * created activity's node id; throws on SDK-reported failure (shared by all
 * activity types).
 */
async function emitActivity(
  client: LinearClient,
  sessionId: string,
  plan: ActivityPlan,
): Promise<string> {
  const payload = await client.createAgentActivity({
    agentSessionId: sessionId,
    content: { type: plan.type, body: plan.body },
  });
  if (!payload?.success) {
    throw new Error(
      `createAgentActivity(${plan.type}) did not succeed for session ${sessionId}`,
    );
  }
  const activity = await payload.agentActivity;
  if (!activity?.id) {
    throw new Error(
      `createAgentActivity(${plan.type}) returned no activity id for session ${sessionId}`,
    );
  }
  return activity.id;
}

/** Type guard narrowing a string to a first-slice {@link ActivityType}. */
function isValidActivityType(type: string): type is ActivityType {
  return type === "thought" || type === "response" || type === "elicitation" || type === "error";
}

/** Strip a ```json … ``` fence wrapper if present; otherwise return as-is. */
function stripFence(raw: string): string {
  const trimmed = raw.trim();
  const fence = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fence ? fence[1] : trimmed;
}

/** Short preview of raw text for error diagnostics (never the full body — may be sensitive). */
function preview(raw: string): string {
  const s = raw.trim().replace(/\n/g, " ");
  return s.length > 120 ? `${s.slice(0, 120)}…` : s;
}

/**
 * If the delegated issue is not in a `started`/`completed`/`canceled` state,
 * move it to the first `started` workflow state (lowest `position`).
 *
 * Matches the best-practices doc's exact query shape: `team.states({ filter:
 * { type: { eq: "started" } } })`, pick the lowest `position`. No-op when the
 * issue is already started/done/canceled or has no issue/session.
 *
 * @returns the state id the issue was moved to, or `null` if it was a no-op.
 */
export async function moveToStartedIfDelegated(
  client: LinearClient,
  event: AgentSessionEvent,
): Promise<string | null> {
  const issueId = event.agentSession?.issueId;
  if (!issueId) {
    return null; // direct-chat session, no issue to move
  }

  const issue = await client.issue(issueId);

  // Only move issues delegated to the agent (delegateId set). Per the doc: if
  // an automation delegated, leave triage/assignment to a human — but here we
  // gate on delegateId presence, which holds for human delegation.
  if (!issue.delegateId) {
    return null;
  }

  const state = await issue.state;
  if (state && STARTED_TYPES[state.type]) {
    return null; // already started/completed/canceled — leave it
  }

  const team = await issue.team;
  if (!team) {
    throw new Error(`issue ${issueId} has no team; cannot resolve a started state.`);
  }

  // Best-practices doc: team.states filtered by type eq "started", pick the
  // lowest position. The PaginationOrderBy enum can't orderBy=position, so
  // the position sort is done client-side below.
  const states = await team.states({
    filter: { type: { eq: "started" } },
  });
  const started = states.nodes
    .slice()
    .sort((a, b) => a.position - b.position)
    .find((s) => s.type === "started");
  if (!started) {
    throw new Error(`no started workflow state found for issue ${issueId}'s team.`);
  }

  const res = await issue.update({ stateId: started.id });
  if (!res?.success) {
    throw new Error(`Linear reported the issue move (${issueId} → started) did not succeed.`);
  }
  return started.id;
}

/** The node ids emitted by one loop run, in emission order (thought first). */
export interface EventLoopResult {
  /** Thought activity id — emitted FIRST to satisfy the 10s SLA. */
  thoughtId: string;
  /** Response activity id — the LLM's primary response (last emitted activity). */
  responseId: string;
  /** State id the issue was moved to, or null if it was already started / no issue. */
  movedToStateId: string | null;
}

/**
 * Run the full loop against an existing client — `emitThought` FIRST (10s SLA),
 * then `driveAgentLoop` (the response), then `moveToStartedIfDelegated`.
 *
 * Split from `runEventLoop` so the loop itself is unit-testable against a stubbed
 * client without touching the network (token minting stays in `runEventLoop`).
 *
 * @returns the emitted activity node ids, in emission order (thought first).
 */
export async function driveLoop(
  client: LinearClient,
  event: AgentSessionEvent,
  completeFn: LLMCompleteFn = llmComplete,
): Promise<EventLoopResult> {
  const sessionId = sessionOf(event);

  // 10s SLA: emit the thought heartbeat BEFORE any other SDK call. Linear
  // marks a new session unresponsive if no activity lands within 10s of the
  // `created` webhook, so this ordering is load-bearing.
  const thoughtId = await emitThought(client, sessionId, "Received the session — starting work.");

  const responseId = await driveAgentLoop(client, event, completeFn);
  const movedToStateId = await moveToStartedIfDelegated(client, event);

  return { thoughtId, responseId, movedToStateId };
}

/**
 * Top-level: build the OAuth client from a minted token, then run the full
 * loop via {@link driveLoop}. Returns the emitted activity node ids.
 *
 * `token` is an already-minted OAuth access_token (Path A client_credentials or
 * the dev_app_token 1Password field); the caller owns the token lifecycle.
 */
export async function runEventLoop(
  event: AgentSessionEvent,
  token: string,
  completeFn: LLMCompleteFn = llmComplete,
  clientFactory: (token: string) => LinearClient = makeOAuthClient,
): Promise<EventLoopResult> {
  return driveLoop(clientFactory(token), event, completeFn);

}
