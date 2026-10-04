import type { LinearClient } from "@linear/sdk";
import type { UpdatedIssue } from "./issues.js";
import { notFoundError, refusedError, usageError } from "../lib/errors.js";
import { withRetry } from "../lib/retry.js";

interface Snapshot {
  id: string; identifier: string; title: string; url: string;
  team: { id: string } | null;
  state: { id: string; name: string; type: string } | null;
  assignee: { displayName: string } | null;
}
export interface DuplicateResult extends UpdatedIssue {
  duplicateOf: { id: string; identifier: string };
}
const ISSUE = `query DuplicateIssue($id: String!) {
  issue(id: $id) { id identifier title url team { id } state { id name type } assignee { displayName } }
}`;
const RELATIONS = `query DuplicateRelations($id: String!, $after: String) {
  issue(id: $id) { relations(first: 100, after: $after) {
    nodes { type relatedIssue { id } } pageInfo { hasNextPage endCursor }
  } }
}`;

/** Create the directed duplicate -> canonical relation, optionally close, and verify each write. */
export async function markDuplicate(client: LinearClient, ref: string, canonicalRef: string, close = false): Promise<DuplicateResult> {
  if (!canonicalRef.trim()) throw usageError("--duplicate-of requires a canonical issue.");
  const query = async <T>(q: string, variables: Record<string, unknown>): Promise<T> => {
    const r = await withRetry(() => client.client.rawRequest<T, Record<string, unknown>>(q, variables));
    if (!r.data) throw new Error("Linear returned no data for the duplicate operation.");
    return r.data;
  };
  const read = async (id: string): Promise<Snapshot> => {
    const { issue } = await query<{ issue: Snapshot | null }>(ISSUE, { id });
    if (!issue) throw notFoundError(`issue ${id} was not found.`);
    return issue;
  };
  const source = await read(ref);
  const canonical = await read(canonicalRef);
  if (source.id === canonical.id) throw usageError("an issue cannot be a duplicate of itself.");

  // Resolve the destination before creating a relation, so a missing state cannot leave a partial close.
  let duplicateState: { id: string; name: string } | undefined;
  if (close) {
    if (!source.team) throw notFoundError("issue has no team; cannot resolve a duplicate state.");
    const states = await query<{ workflowStates: { nodes: Array<{ id: string; name: string }> } }>(
      `query DuplicateState($team: ID!) { workflowStates(first: 100, filter: { team: { id: { eq: $team } }, type: { eq: "duplicate" } }) { nodes { id name } } }`,
      { team: source.team.id },
    );
    duplicateState = states.workflowStates.nodes.find(s => s.name.toLowerCase() === "duplicate") ?? states.workflowStates.nodes[0];
    if (!duplicateState) throw notFoundError("no duplicate-type workflow state found for this team.");
  }
  const targets = async (): Promise<string[]> => {
    const ids: string[] = [];
    let after: string | null = null;
    const cursors = new Set<string>();
    for (;;) {
      const r: { issue: { relations: { nodes: Array<{ type: string; relatedIssue: { id: string } }>; pageInfo: { hasNextPage: boolean; endCursor: string | null } } } | null } = await query(RELATIONS, { id: source.id, after });
      if (!r.issue) throw notFoundError(`issue ${source.identifier} was not found during verification.`);
      const { nodes, pageInfo } = r.issue.relations;
      ids.push(...nodes.filter(n => n.type === "duplicate").map(n => n.relatedIssue.id));
      if (!pageInfo.hasNextPage) return ids;
      if (!pageInfo.endCursor || cursors.has(pageInfo.endCursor)) throw new Error("duplicate relation pagination did not advance.");
      after = pageInfo.endCursor;
      cursors.add(after);
    }
  };
  const verifyTargets = (ids: string[]) => {
    if (ids.some(id => id !== canonical.id)) throw refusedError("issue already has a different duplicate target.", "Inspect its relations before changing the canonical issue.");
  };
  const existing = await targets();
  verifyTargets(existing);
  if (!existing.includes(canonical.id)) {
    const r = await query<{ issueRelationCreate: { success: boolean } }>(
      `mutation DuplicateRelationCreate($input: IssueRelationCreateInput!) { issueRelationCreate(input: $input) { success } }`,
      { input: { issueId: source.id, relatedIssueId: canonical.id, type: "duplicate" } },
    );
    if (!r.issueRelationCreate.success) throw new Error("Linear reported the duplicate relation did not succeed.");
  }
  const verified = await targets();
  verifyTargets(verified);
  if (!verified.includes(canonical.id)) throw refusedError("duplicate relation was not present on re-read.", "The write may have succeeded; inspect both issues before retrying.");
  if (duplicateState) {
    const r = await query<{ issueUpdate: { success: boolean } }>(
      `mutation DuplicateClose($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }`,
      { id: source.id, input: { stateId: duplicateState.id } },
    );
    if (!r.issueUpdate.success) throw new Error("duplicate relation exists, but Linear reported the close did not succeed.");
  }
  const final = await read(source.id);
  if (duplicateState && (final.state?.id !== duplicateState.id || final.state.type !== "duplicate")) {
    throw refusedError("duplicate relation exists, but duplicate state was not confirmed on re-read.", "Inspect the issue before retrying; no rollback was attempted.");
  }
  return { id: final.id, identifier: final.identifier, title: final.title, url: final.url,
    state: final.state?.name ?? "", assignee: final.assignee?.displayName ?? null,
    duplicateOf: { id: canonical.id, identifier: canonical.identifier } };
}
