import type { LinearClient, Issue } from "@linear/sdk";
import { resolveTeamByKey } from "./teams.js";
import { pickLabelIds } from "../lib/labels.js";
import { withRetry } from "../lib/retry.js";
import { resolveMilestoneId } from "./milestones.js";
import { resolveCycleId } from "./cycles.js";

export interface CreateIssueParams {
  teamKey: string;
  title: string;
  description?: string;
  projectId?: string;
  labels?: string[];
  assignee?: string;
  priority?: number;
  milestone?: string;
  /** Cycle ref: a number, 'current'/'next', a cycle id, or 'none'. */
  cycle?: string;
  /** Parent issue (UUID or identifier) — creates as a sub-issue. */
  parent?: string;
  /** Create directly in the team's state of this TYPE (e.g. "backlog"). */
  stateType?: string;
  /** Label names to attach, creating any that don't exist on the team. */
  ensureLabels?: string[];
}

export interface CreatedIssue {
  id: string;
  identifier: string;
  title: string;
  url: string;
}

/**
 * Create a Linear issue.
 *
 * Resolves the team by key, resolves any label names to IDs (case-insensitive,
 * errors on any unmatched), then `createIssue`. Pure domain logic: the caller
 * supplies a fully-resolved `description` string (the CLI's `--desc -` stdin
 * handling stays in the command layer) and shapes the output.
 */
export async function createIssue(
  client: LinearClient,
  params: CreateIssueParams,
): Promise<CreatedIssue> {
  const team = await resolveTeamByKey(client, params.teamKey);

  const labelIds = params.labels?.length
    ? await resolveLabelIds(client, team.id, params.labels)
    : [];
  if (params.ensureLabels?.length) {
    labelIds.push(...(await ensureLabelIds(client, team.id, params.ensureLabels)));
  }
  const assigneeId = params.assignee
    ? await resolveAssignee(client, params.assignee)
    : undefined;
  let stateId: string | undefined;
  if (params.stateType) {
    const states = await withRetry(() =>
      client.workflowStates({ filter: { team: { id: { eq: team.id } } } }),
    );
    const state = states.nodes.find((s) => s.type === params.stateType);
    if (!state) {
      throw new Error(`no ${params.stateType} workflow state found for team ${params.teamKey}.`);
    }
    stateId = state.id;
  }
  const projectMilestoneId = params.milestone
    ? await resolveMilestoneId(client, params.milestone, params.projectId)
    : undefined;
  const cycleId = params.cycle
    ? await resolveCycleId(client, params.teamKey, params.cycle)
    : undefined;
  const parentId = params.parent
    ? await resolveIssueId(client, params.parent)
    : undefined;

  const res = await withRetry(() =>
    client.createIssue({
      teamId: team.id,
      title: params.title,
      ...(params.description ? { description: params.description } : {}),
      ...(params.projectId ? { projectId: params.projectId } : {}),
      ...(labelIds.length ? { labelIds } : {}),
      ...(assigneeId ? { assigneeId } : {}),
      ...(params.priority !== undefined ? { priority: params.priority } : {}),
      ...(projectMilestoneId ? { projectMilestoneId } : {}),
      ...(cycleId ? { cycleId } : {}),
      ...(stateId ? { stateId } : {}),
      ...(parentId ? { parentId } : {}),
    }),
  );
  if (!res.success) {
    throw new Error("Linear reported the issue create did not succeed.");
  }
  const issue = await res.issue;
  if (!issue) {
    throw new Error("issue created but the payload returned no issue.");
  }

  return {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    url: issue.url,
  };
}

export interface UpdateIssueParams {
  state?: string;
  assignee?: string;
  labels?: string[];
  projectId?: string;
  priority?: number;
  milestone?: string;
  /** Cycle ref: a number, 'current'/'next', a cycle id, or 'none' to remove. */
  cycle?: string;
  title?: string;
  description?: string;
  /** Re-parent under this issue (UUID or identifier). */
  parent?: string;
}

export interface UpdatedIssue {
  id: string;
  identifier: string;
  title: string;
  url: string;
  state: string;
  assignee: string | null;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Resolve an assignee: `"me"` → viewer, a UUID passes through, else by email / display name / name. */
export async function resolveAssignee(client: LinearClient, who: string): Promise<string> {
  if (who === "me") return (await client.viewer).id;
  if (UUID_RE.test(who)) return who;
  const users = await client.users({
    filter: {
      or: [
        { email: { eqIgnoreCase: who } },
        { displayName: { eqIgnoreCase: who } },
        { name: { eqIgnoreCase: who } },
      ],
    },
  });
  const user = users.nodes[0];
  if (!user) {
    throw new Error(
      `no user matching ${JSON.stringify(who)} — try "me", an email, or a display name.`,
    );
  }
  return user.id;
}

/**
 * Resolve label names to IDs, SCOPED to the target team (plus workspace-global
 * labels), case-insensitively.
 *
 * Linear labels are team-scoped: a workspace-wide name match can return a
 * *different* team's label, which the API then rejects with "LabelIds for
 * incorrect team". Filtering by `team.id` (or null = workspace) prevents that.
 * Throws — listing every miss — on any unmatched name (via `pickLabelIds`).
 */
async function resolveLabelIds(
  client: LinearClient,
  teamId: string,
  names: string[],
): Promise<string[]> {
  const filter = {
    and: [
      { or: [{ team: { id: { eq: teamId } } }, { team: { null: true } }] },
      { or: names.map((n) => ({ name: { eqIgnoreCase: n } })) },
    ],
  };
  const labels = await withRetry(() => client.issueLabels({ filter }));
  return pickLabelIds(labels.nodes, names);
}

/** Resolve an issue ref (UUID or identifier like CER-123) to its UUID. */
export async function resolveIssueId(client: LinearClient, ref: string): Promise<string> {
  if (UUID_RE.test(ref)) return ref;
  const issue = await withRetry(() => client.issue(ref));
  return issue.id;
}

export interface RelationSpec {
  blockedBy?: string[];
  relatedTo?: string[];
}

/**
 * Wire issue relations: `blockedBy` creates blocks-relations FROM each blocker
 * TO the target (Linear semantics: issueId blocks relatedIssueId); `relatedTo`
 * creates related-links. Idempotent server-side (duplicate relations error —
 * surfaced, not swallowed). Fills CER-1192 item 2 / CER-1342.
 */
export async function addRelations(
  client: LinearClient,
  targetRef: string,
  spec: RelationSpec,
): Promise<{ blockedBy: string[]; relatedTo: string[] }> {
  const targetId = await resolveIssueId(client, targetRef);
  const done = { blockedBy: [] as string[], relatedTo: [] as string[] };
  for (const ref of spec.blockedBy ?? []) {
    const blockerId = await resolveIssueId(client, ref);
    const res = await withRetry(() =>
      client.createIssueRelation({
        issueId: blockerId,
        relatedIssueId: targetId,
        type: "blocks" as Parameters<LinearClient["createIssueRelation"]>[0]["type"],
      }),
    );
    if (!res.success) throw new Error(`could not create blocked-by relation from ${ref}.`);
    done.blockedBy.push(ref);
  }
  for (const ref of spec.relatedTo ?? []) {
    const otherId = await resolveIssueId(client, ref);
    const res = await withRetry(() =>
      client.createIssueRelation({
        issueId: targetId,
        relatedIssueId: otherId,
        type: "related" as Parameters<LinearClient["createIssueRelation"]>[0]["type"],
      }),
    );
    if (!res.success) throw new Error(`could not create related-to relation to ${ref}.`);
    done.relatedTo.push(ref);
  }
  return done;
}

/** Attach a URL to an issue (PR links etc.) — CER-1192 item 3. */
export async function attachLink(
  client: LinearClient,
  issueRef: string,
  url: string,
  title?: string,
): Promise<{ identifier: string; url: string }> {
  const issueId = await resolveIssueId(client, issueRef);
  const res = await withRetry(() =>
    client.createAttachment({ issueId, url, title: title ?? url }),
  );
  if (!res.success) throw new Error("Linear reported the attachment create did not succeed.");
  return { identifier: issueRef, url };
}

/**
 * Resolve label names to ids, CREATING any that don't exist on the team —
 * the opposite contract to `resolveLabelIds`' fail-loud. Used by `park`'s
 * auto-attached `user-story` label (docs/features/park.md).
 */
export async function ensureLabelIds(
  client: LinearClient,
  teamId: string,
  names: string[],
): Promise<string[]> {
  const filter = {
    and: [
      { or: [{ team: { id: { eq: teamId } } }, { team: { null: true } }] },
      { or: names.map((n) => ({ name: { eqIgnoreCase: n } })) },
    ],
  };
  const existing = await withRetry(() => client.issueLabels({ filter }));
  const byName = new Map(existing.nodes.map((l) => [l.name.toLowerCase(), l.id]));
  const ids: string[] = [];
  for (const name of names) {
    const found = byName.get(name.trim().toLowerCase());
    if (found) {
      ids.push(found);
      continue;
    }
    const res = await withRetry(() => client.createIssueLabel({ teamId, name }));
    const label = await res.issueLabel;
    if (!res.success || !label) {
      throw new Error(`could not create label ${JSON.stringify(name)}.`);
    }
    ids.push(label.id);
  }
  return ids;
}

/** Resolve a workflow-state name to its ID within a team (case-insensitive). */
async function resolveStateId(
  client: LinearClient,
  teamId: string,
  name: string,
): Promise<string> {
  const states = await client.workflowStates({ filter: { team: { id: { eq: teamId } } } });
  const target = name.trim().toLowerCase();
  const state = states.nodes.find((s) => s.name.toLowerCase() === target);
  if (!state) {
    const avail = states.nodes.map((s) => s.name).join(", ");
    throw new Error(
      `no workflow state ${JSON.stringify(name)} for this team — available: ${avail}.`,
    );
  }
  return state.id;
}

async function summarize(issue: Issue): Promise<UpdatedIssue> {
  const state = issue.state ? await issue.state : undefined;
  const assignee = issue.assignee ? await issue.assignee : undefined;
  return {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    url: issue.url,
    state: state?.name ?? "",
    assignee: assignee?.displayName ?? null,
  };
}

/**
 * Update an issue: state (by name), assignee (`me`/email/name/id), labels
 * (replaces), project, priority. Resolves names against the issue's own team.
 * Throws if no field is supplied.
 */
export async function updateIssue(
  client: LinearClient,
  id: string,
  params: UpdateIssueParams,
): Promise<UpdatedIssue> {
  const issue = await withRetry(() => client.issue(id));

  // State + labels both resolve against the issue's own team.
  let teamId: string | undefined;
  if (params.state || params.labels?.length) {
    const team = await issue.team;
    if (!team) throw new Error("issue has no team; cannot resolve state/labels.");
    teamId = team.id;
  }
  const stateId = params.state ? await resolveStateId(client, teamId!, params.state) : undefined;
  const assigneeId = params.assignee
    ? await resolveAssignee(client, params.assignee)
    : undefined;
  const labelIds = params.labels?.length
    ? await resolveLabelIds(client, teamId!, params.labels)
    : undefined;
  let projectMilestoneId: string | undefined;
  if (params.milestone) {
    const project = await issue.project;
    projectMilestoneId = await resolveMilestoneId(client, params.milestone, project?.id);
  }
  // cycle is per-team; resolve against the issue's own team. `none` → null,
  // which removes the issue from its cycle (hence the !== undefined guard below).
  let cycleId: string | null | undefined;
  if (params.cycle !== undefined) {
    const team = await issue.team;
    if (!team) throw new Error("issue has no team; cannot resolve --cycle.");
    cycleId = await resolveCycleId(client, team.key, params.cycle);
  }
  const parentId = params.parent ? await resolveIssueId(client, params.parent) : undefined;

  const input = {
    ...(stateId ? { stateId } : {}),
    ...(assigneeId ? { assigneeId } : {}),
    ...(labelIds?.length ? { labelIds } : {}),
    ...(params.projectId ? { projectId: params.projectId } : {}),
    ...(params.priority !== undefined ? { priority: params.priority } : {}),
    ...(projectMilestoneId ? { projectMilestoneId } : {}),
    ...(cycleId !== undefined ? { cycleId } : {}),
    ...(params.title !== undefined ? { title: params.title } : {}),
    ...(params.description !== undefined ? { description: params.description } : {}),
    ...(parentId ? { parentId } : {}),
  };
  if (Object.keys(input).length === 0) {
    throw new Error(
      "nothing to update — pass at least one of state / assignee / labels / project / priority.",
    );
  }

  const res = await withRetry(() => client.updateIssue(issue.id, input));
  if (!res.success) {
    throw new Error("Linear reported the issue update did not succeed.");
  }
  const updated = await res.issue;
  if (!updated) {
    throw new Error("issue updated but the payload returned no issue.");
  }
  return summarize(updated);
}

/** Close an issue: move it to the team's completed state (prefers one named "Done"). */
export async function closeIssue(client: LinearClient, id: string): Promise<UpdatedIssue> {
  const issue = await withRetry(() => client.issue(id));
  const team = await issue.team;
  if (!team) throw new Error("issue has no team; cannot resolve a completed state.");

  const states = await client.workflowStates({ filter: { team: { id: { eq: team.id } } } });
  const done =
    states.nodes.find((s) => s.type === "completed" && /done/i.test(s.name)) ??
    states.nodes.find((s) => s.type === "completed");
  if (!done) {
    throw new Error("no completed workflow state found for this team.");
  }

  const res = await withRetry(() => client.updateIssue(issue.id, { stateId: done.id }));
  if (!res.success) {
    throw new Error("Linear reported the issue close did not succeed.");
  }
  const updated = await res.issue;
  if (!updated) {
    throw new Error("issue closed but the payload returned no issue.");
  }
  return summarize(updated);
}

export interface IssueDetail {
  id: string;
  identifier: string;
  title: string;
  url: string;
  state: string;
  stateType: string;
  assignee: string | null;
  priority: string;
  project: string | null;
  labels: string[];
  parent: string | null;
  description: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Fetch one issue's full detail — the read half the CLI lacked (PR-body
 * archaeology was the workaround). Resolves the SDK's lazy relations
 * (state/assignee/project/parent/labels) into a flat, render-ready record.
 */
export async function getIssue(client: LinearClient, id: string): Promise<IssueDetail> {
  const issue = await client.issue(id);
  const [state, assignee, project, parent, labels] = await Promise.all([
    issue.state,
    issue.assignee,
    issue.project,
    issue.parent,
    issue.labels(),
  ]);
  return {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    url: issue.url,
    state: state?.name ?? "",
    stateType: state?.type ?? "",
    assignee: assignee?.displayName ?? null,
    priority: issue.priorityLabel,
    project: project?.name ?? null,
    labels: labels.nodes.map((l) => l.name),
    parent: parent?.identifier ?? null,
    description: issue.description ?? null,
    createdAt: new Date(issue.createdAt).toISOString(),
    updatedAt: new Date(issue.updatedAt).toISOString(),
  };
}

/** Render an {@link IssueDetail} for the terminal: header, metadata, body. */
export function renderIssueDetail(d: IssueDetail): string {
  const meta = [
    `  url: ${d.url}`,
    `  priority: ${d.priority}${d.assignee ? `   assignee: ${d.assignee}` : ""}`,
    ...(d.project ? [`  project: ${d.project}`] : []),
    ...(d.labels.length ? [`  labels: ${d.labels.join(", ")}`] : []),
    ...(d.parent ? [`  parent: ${d.parent}`] : []),
    `  created: ${d.createdAt}   updated: ${d.updatedAt}`,
  ].join("\n");
  const body = d.description?.trim() ? d.description : "(no description)";
  return `${d.identifier} [${d.state}]: ${d.title}\n${meta}\n\n${body}\n`;
}

/**
 * Start an issue: move it to the team's `started` state (prefers one named
 * "In Progress"). The write half of `xref --fix`'s non-closing nudge.
 */
export async function startIssue(client: LinearClient, id: string): Promise<UpdatedIssue> {
  const issue = await client.issue(id);
  const team = await issue.team;
  if (!team) throw new Error("issue has no team; cannot resolve a started state.");

  const states = await client.workflowStates({ filter: { team: { id: { eq: team.id } } } });
  const started =
    states.nodes.find((s) => s.type === "started" && /in progress/i.test(s.name)) ??
    states.nodes.find((s) => s.type === "started");
  if (!started) {
    throw new Error("no started workflow state found for this team.");
  }

  const res = await client.updateIssue(issue.id, { stateId: started.id });
  if (!res.success) {
    throw new Error("Linear reported the issue start did not succeed.");
  }
  const updated = await res.issue;
  if (!updated) {
    throw new Error("issue started but the payload returned no issue.");
  }
  return summarize(updated);
}

export interface CommentResult {
  identifier: string;
  commentId: string;
  url: string;
}

/**
 * Add a comment to an issue. `id` accepts a UUID or identifier (CER-123).
 * Single Linear mutation: `createComment({ issueId, body })`. Non-destructive
 * (additive) — the gap between `update`/`close` (mutate fields) and `show`
 * (read), per `docs/features/comment.md`.
 */
export async function createComment(
  client: LinearClient,
  id: string,
  body: string,
): Promise<CommentResult> {
  const issue = await withRetry(() => client.issue(id));
  const res = await withRetry(() =>
    client.createComment({ issueId: issue.id, body }),
  );
  if (!res.success) {
    throw new Error("Linear reported the comment create did not succeed.");
  }
  const comment = await res.comment;
  if (!comment) {
    throw new Error("comment created but the payload returned no comment.");
  }
  return {
    identifier: issue.identifier,
    commentId: comment.id,
    url: issue.url,
  };
}
