import type { LinearClient, Issue } from "@linear/sdk";
import { resolveTeamByKey } from "./teams.js";
import { pickLabelIds } from "../lib/labels.js";
import { withRetry } from "../lib/retry.js";

export interface CreateIssueParams {
  teamKey: string;
  title: string;
  description?: string;
  projectId?: string;
  labels?: string[];
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

  let labelIds: string[] = [];
  if (params.labels?.length) {
    const filter = { or: params.labels.map((n) => ({ name: { eqIgnoreCase: n } })) };
    const labels = await client.issueLabels({ filter });
    labelIds = pickLabelIds(labels.nodes, params.labels);
  }

  const res = await withRetry(() =>
    client.createIssue({
      teamId: team.id,
      title: params.title,
      ...(params.description ? { description: params.description } : {}),
      ...(params.projectId ? { projectId: params.projectId } : {}),
      ...(labelIds.length ? { labelIds } : {}),
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
async function resolveAssignee(client: LinearClient, who: string): Promise<string> {
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

  let stateId: string | undefined;
  if (params.state) {
    const team = await issue.team;
    if (!team) throw new Error("issue has no team; cannot resolve a state.");
    stateId = await resolveStateId(client, team.id, params.state);
  }
  const assigneeId = params.assignee
    ? await resolveAssignee(client, params.assignee)
    : undefined;
  let labelIds: string[] | undefined;
  if (params.labels?.length) {
    const filter = { or: params.labels.map((n) => ({ name: { eqIgnoreCase: n } })) };
    const labels = await client.issueLabels({ filter });
    labelIds = pickLabelIds(labels.nodes, params.labels);
  }

  const input = {
    ...(stateId ? { stateId } : {}),
    ...(assigneeId ? { assigneeId } : {}),
    ...(labelIds?.length ? { labelIds } : {}),
    ...(params.projectId ? { projectId: params.projectId } : {}),
    ...(params.priority !== undefined ? { priority: params.priority } : {}),
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
