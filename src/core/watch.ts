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

import type { LinearClient } from "@linear/sdk";
import { makeOAuthClient } from "../client.js";

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
 * V1 (by design — NO LLM yet): emits a `response` activity echoing the issue
 * identifier and the first 200 chars of `promptContext`. Proves the
 * createAgentActivity round-trip end to end; the LLM-backed reasoning is a
 * follow-up that swaps in here without touching the call sites.
 *
 * @returns the created `response` activity's node id.
 */
export async function driveAgentLoop(
  client: LinearClient,
  event: AgentSessionEvent,
): Promise<string> {
  const sessionId = sessionOf(event);

  // Fetch the session to read its activities (conversation history). The
  // best-practices doc: reconstruct history from Agent Activities, not
  // editable comments.
  const session = await client.agentSession(sessionId);
  const activities = await session.activities();

  // V1 echo — summarize the activity count + promptContext snippet. No LLM.
  const historyCount = activities.nodes.length;
  const context = event.promptContext ?? "";
  const summary = context.slice(0, 200);

  const issueId = event.agentSession.issueId ?? "unknown";
  const body =
    `Received: ${issueId} — promptContext summary: ${summary}\n` +
    `(session history: ${historyCount} activity/activities)`;

  const payload = await client.createAgentActivity({
    agentSessionId: sessionId,
    content: { type: "response", body },
  });
  if (!payload?.success) {
    throw new Error(
      `createAgentActivity(response) did not succeed for session ${sessionId}`,
    );
  }
  const activity = await payload.agentActivity;
  if (!activity?.id) {
    throw new Error(
      `createAgentActivity(response) returned no activity id for session ${sessionId}`,
    );
  }
  return activity.id;
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
  /** Response activity id — the V1 echo. */
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
): Promise<EventLoopResult> {
  const sessionId = sessionOf(event);

  // 10s SLA: emit the thought heartbeat BEFORE any other SDK call. Linear
  // marks a new session unresponsive if no activity lands within 10s of the
  // `created` webhook, so this ordering is load-bearing.
  const thoughtId = await emitThought(client, sessionId, "Received the session — starting work.");

  const responseId = await driveAgentLoop(client, event);
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
): Promise<EventLoopResult> {
  return driveLoop(makeOAuthClient(token), event);
}
