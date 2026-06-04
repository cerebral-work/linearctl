import type { LinearClient } from "@linear/sdk";
import { resolveTeamByKey } from "./teams.js";
import { pickLabelIds } from "../lib/labels.js";

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

  const res = await client.createIssue({
    teamId: team.id,
    title: params.title,
    ...(params.description ? { description: params.description } : {}),
    ...(params.projectId ? { projectId: params.projectId } : {}),
    ...(labelIds.length ? { labelIds } : {}),
  });
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
