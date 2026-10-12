import type { LinearClient } from "@linear/sdk";
import { withRetry } from "../../lib/retry.js";
import {
  type BeadsIssue,
  type BeadsDependency,
  type BeadsSyncOptions,
  type BeadsSyncStats,
  linearPriorityToBeads,
  linearStateTypeToBeads,
  beadsStatusToLinearStateType,
  inferIssueType,
} from "./types.js";
import { type BeadsDiscoveryResult } from "./discovery.js";
import { loadBeadsIssues, saveBeadsIssues, loadBeadsMetadata, saveBeadsMetadata } from "./store.js";
import { getReadyIssues } from "./graph.js";

const LINEAR_BEADS_ISSUES_QUERY = /* GraphQL */ `
  query LinearBeadsIssues($filter: IssueFilter, $first: Int!, $after: String) {
    issues(filter: $filter, first: $first, after: $after) {
      nodes {
        id
        identifier
        title
        description
        url
        priority
        createdAt
        updatedAt
        startedAt
        completedAt
        canceledAt
        dueDate
        state {
          id
          name
          type
        }
        assignee {
          id
          name
          displayName
          email
        }
        labels {
          nodes {
            name
          }
        }
        parent {
          id
          identifier
        }
        children {
          nodes {
            id
          }
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

const LINEAR_BEADS_RELATIONS_QUERY = /* GraphQL */ `
  query LinearBeadsRelations($first: Int!, $after: String) {
    issueRelations(first: $first, after: $after, includeArchived: false) {
      nodes {
        id
        type
        issue {
          id
          identifier
        }
        relatedIssue {
          id
          identifier
        }
        createdAt
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

interface RawLinearIssueNode {
  id: string;
  identifier: string;
  title: string;
  description?: string | null;
  url: string;
  priority?: number | null;
  createdAt: string;
  updatedAt: string;
  startedAt?: string | null;
  completedAt?: string | null;
  canceledAt?: string | null;
  dueDate?: string | null;
  state?: { id: string; name: string; type: string } | null;
  assignee?: { id: string; name: string; displayName?: string | null; email?: string | null } | null;
  labels?: { nodes: { name: string }[] } | null;
  parent?: { id: string; identifier: string } | null;
  children?: { nodes: { id: string }[] } | null;
}

interface RawLinearRelationNode {
  id: string;
  type: string;
  issue: { id: string; identifier: string };
  relatedIssue: { id: string; identifier: string };
  createdAt?: string;
}

/**
 * Fetch issues from Linear GraphQL API with pagination.
 */
export async function fetchLinearIssues(
  client: LinearClient,
  options: BeadsSyncOptions
): Promise<RawLinearIssueNode[]> {
  const allNodes: RawLinearIssueNode[] = [];
  let after: string | undefined = undefined;

  // Build filter
  const filter: Record<string, unknown> = {};
  if (options.team && options.team.length > 0) {
    if (options.team.length === 1) {
      filter.team = { key: { eq: options.team[0] } };
    } else {
      filter.team = { key: { in: options.team } };
    }
  }
  if (options.project) {
    filter.project = { id: { eq: options.project } };
  }

  while (true) {
    const res: { issues: { nodes: RawLinearIssueNode[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } } =
      await withRetry(() =>
        (client as unknown as { client: { rawRequest: (query: string, vars: unknown) => Promise<{ data: unknown }> } })
          .client.rawRequest(LINEAR_BEADS_ISSUES_QUERY, {
            filter: Object.keys(filter).length > 0 ? filter : undefined,
            first: 100,
            after,
          })
      ).then((r) => r.data as { issues: { nodes: RawLinearIssueNode[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } });

    allNodes.push(...res.issues.nodes);

    if (!res.issues.pageInfo.hasNextPage || !res.issues.pageInfo.endCursor) {
      break;
    }
    after = res.issues.pageInfo.endCursor;
  }

  return allNodes;
}

/**
 * Fetch issue relations from Linear GraphQL API.
 */
export async function fetchLinearRelations(client: LinearClient): Promise<RawLinearRelationNode[]> {
  const allNodes: RawLinearRelationNode[] = [];
  let after: string | undefined = undefined;

  try {
    while (true) {
      const res: { issueRelations: { nodes: RawLinearRelationNode[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } } =
        await withRetry(() =>
          (client as unknown as { client: { rawRequest: (query: string, vars: unknown) => Promise<{ data: unknown }> } })
            .client.rawRequest(LINEAR_BEADS_RELATIONS_QUERY, {
              first: 100,
              after,
            })
        ).then((r) => r.data as { issueRelations: { nodes: RawLinearRelationNode[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } });

      allNodes.push(...res.issueRelations.nodes);

      if (!res.issueRelations.pageInfo.hasNextPage || !res.issueRelations.pageInfo.endCursor) {
        break;
      }
      after = res.issueRelations.pageInfo.endCursor;
    }
  } catch {
    // If relation query fails (e.g. lack of permissions or schema variation), return whatever was collected
  }

  return allNodes;
}

/**
 * Convert Linear entities into Beads issues and graph dependencies.
 */
export function convertLinearToBeads(
  rawIssues: RawLinearIssueNode[],
  rawRelations: RawLinearRelationNode[] = []
): BeadsIssue[] {
  // Index of issue identifier to dependencies
  const dependenciesByIdentifier = new Map<string, BeadsDependency[]>();

  // Map relations:
  // In Linear: relation.type === "blocks" means `issue` BLOCKS `relatedIssue`.
  // Therefore `relatedIssue` DEPENDS ON `issue`.
  for (const rel of rawRelations) {
    if (!rel.issue?.identifier || !rel.relatedIssue?.identifier) continue;

    if (rel.type === "blocks") {
      const blockedId = rel.relatedIssue.identifier;
      const blockerId = rel.issue.identifier;
      const deps = dependenciesByIdentifier.get(blockedId) || [];
      deps.push({
        id: rel.id,
        issue_id: blockedId,
        depends_on_id: blockerId,
        type: "blocks",
        created_at: rel.createdAt,
      });
      dependenciesByIdentifier.set(blockedId, deps);
    } else if (rel.type === "duplicate") {
      const dupeId = rel.issue.identifier;
      const canonicalId = rel.relatedIssue.identifier;
      const deps = dependenciesByIdentifier.get(dupeId) || [];
      deps.push({
        id: rel.id,
        issue_id: dupeId,
        depends_on_id: canonicalId,
        type: "duplicates",
        created_at: rel.createdAt,
      });
      dependenciesByIdentifier.set(dupeId, deps);
    } else if (rel.type === "related") {
      const deps = dependenciesByIdentifier.get(rel.issue.identifier) || [];
      deps.push({
        id: rel.id,
        issue_id: rel.issue.identifier,
        depends_on_id: rel.relatedIssue.identifier,
        type: "related",
        created_at: rel.createdAt,
      });
      dependenciesByIdentifier.set(rel.issue.identifier, deps);
    }
  }

  // Convert issues
  const beadsIssues: BeadsIssue[] = [];

  for (const raw of rawIssues) {
    const labels = raw.labels?.nodes?.map((l) => l.name) || [];
    const hasChildren = (raw.children?.nodes?.length || 0) > 0;
    const issueType = inferIssueType(labels, hasChildren);

    const deps = dependenciesByIdentifier.get(raw.identifier) || [];

    // Add parent dependency if present
    if (raw.parent?.identifier) {
      deps.push({
        issue_id: raw.identifier,
        depends_on_id: raw.parent.identifier,
        type: "parent-child",
      });
    }

    const beadsIssue: BeadsIssue = {
      id: raw.identifier,
      title: raw.title,
      description: raw.description || undefined,
      status: linearStateTypeToBeads(raw.state?.type),
      priority: linearPriorityToBeads(raw.priority),
      issue_type: issueType,
      assignee: raw.assignee?.displayName || raw.assignee?.name || raw.assignee?.email || undefined,
      owner: raw.assignee?.displayName || undefined,
      created_at: raw.createdAt,
      updated_at: raw.updatedAt,
      started_at: raw.startedAt || undefined,
      closed_at: raw.completedAt || raw.canceledAt || undefined,
      due_at: raw.dueDate || undefined,
      external_ref: raw.url || raw.identifier,
      source_system: "linear",
      labels: labels.length > 0 ? labels : undefined,
      dependencies: deps.length > 0 ? deps : undefined,
    };

    beadsIssues.push(beadsIssue);
  }

  return beadsIssues;
}

/**
 * Pull issues and relations from Linear into the local Beads store.
 */
export async function pullFromLinear(
  client: LinearClient,
  discovery: BeadsDiscoveryResult,
  options: BeadsSyncOptions = {}
): Promise<BeadsSyncStats> {
  const startTime = Date.now();
  const existingLocal = loadBeadsIssues(discovery);
  const localById = new Map<string, BeadsIssue>();
  for (const issue of existingLocal) {
    localById.set(issue.id, issue);
    if (issue.external_ref) {
      localById.set(issue.external_ref, issue);
    }
  }

  const rawIssues = await fetchLinearIssues(client, options);
  const rawRelations = await fetchLinearRelations(client);
  const remoteBeads = convertLinearToBeads(rawIssues, rawRelations);

  let created = 0;
  let updated = 0;
  let conflicts = 0;

  const mergedMap = new Map<string, BeadsIssue>();

  // 1. Process remote issues
  for (const remote of remoteBeads) {
    const local = localById.get(remote.id) || (remote.external_ref ? localById.get(remote.external_ref) : undefined);

    if (!local) {
      mergedMap.set(remote.id, remote);
      created++;
    } else {
      // Check for conflict
      const localUpdated = new Date(local.updated_at).getTime();
      const remoteUpdated = new Date(remote.updated_at).getTime();

      if (options.preferLocal) {
        mergedMap.set(remote.id, local);
      } else if (options.preferLinear) {
        mergedMap.set(remote.id, remote);
        if (localUpdated !== remoteUpdated) updated++;
      } else {
        // Newer wins
        if (remoteUpdated >= localUpdated) {
          mergedMap.set(remote.id, remote);
          if (remoteUpdated > localUpdated) updated++;
        } else {
          mergedMap.set(remote.id, local);
          conflicts++;
        }
      }
    }
  }

  // 2. Preserve local issues that do not exist remotely yet (local-only beads)
  for (const local of existingLocal) {
    if (!mergedMap.has(local.id)) {
      mergedMap.set(local.id, local);
    }
  }

  const merged = Array.from(mergedMap.values());

  if (!options.dryRun) {
    saveBeadsIssues(discovery, merged);
    const meta = loadBeadsMetadata(discovery) || {
      backend: "linearctl",
      version: "1.0.0",
    };
    meta.last_sync = new Date().toISOString();
    if (options.team && options.team.length > 0) {
      meta.team_ids = options.team;
    }
    saveBeadsMetadata(discovery, meta);
  }

  const ready = getReadyIssues(merged);

  return {
    pulled: remoteBeads.length,
    created,
    updated,
    pushed: 0,
    pushedCreated: 0,
    pushedUpdated: 0,
    conflicts,
    readyCount: ready.length,
    totalLocal: merged.length,
    durationMs: Date.now() - startTime,
  };
}

/**
 * Push local changes from Beads back to Linear.
 */
export async function pushToLinear(
  client: LinearClient,
  discovery: BeadsDiscoveryResult,
  options: BeadsSyncOptions = {}
): Promise<BeadsSyncStats> {
  const startTime = Date.now();
  const localIssues = loadBeadsIssues(discovery);
  const metadata = loadBeadsMetadata(discovery);
  const lastSyncTime = metadata?.last_sync ? new Date(metadata.last_sync).getTime() : 0;

  let pushedCreated = 0;
  let pushedUpdated = 0;

  const updatedIssues = [...localIssues];

  for (let i = 0; i < updatedIssues.length; i++) {
    const issue = updatedIssues[i];
    const isLocalOnly = !issue.external_ref || issue.id.startsWith("bd-");

    if (isLocalOnly) {
      // Create new issue in Linear
      const teamKey = options.team?.[0] || metadata?.team_ids?.[0];
      if (!teamKey) {
        continue; // Cannot push without target team
      }

      if (!options.dryRun) {
        try {
          const team = (await client.teams({ filter: { key: { eq: teamKey } } })).nodes[0];
          if (team) {
            const stateType = beadsStatusToLinearStateType(issue.status);
            const states = await client.workflowStates({ filter: { team: { id: { eq: team.id } } } });
            const state = states.nodes.find((s) => s.type === stateType);

            const res = await client.createIssue({
              teamId: team.id,
              title: issue.title,
              description: issue.description,
              stateId: state?.id,
            });

            const createdIssue = await res.issue;
            if (createdIssue) {
              updatedIssues[i] = {
                ...issue,
                id: createdIssue.identifier,
                external_ref: createdIssue.url,
                updated_at: new Date().toISOString(),
              };
              pushedCreated++;
            }
          }
        } catch {
          // Continue on error
        }
      } else {
        pushedCreated++;
      }
    } else {
      // Existing Linear issue: check if local state mutated since last sync
      const localUpdated = new Date(issue.updated_at).getTime();
      if (localUpdated > lastSyncTime && lastSyncTime > 0) {
        if (!options.dryRun) {
          try {
            const linearIssue = await client.issue(issue.id);
            const team = await linearIssue.team;
            if (team) {
              const stateType = beadsStatusToLinearStateType(issue.status);
              const states = await client.workflowStates({ filter: { team: { id: { eq: team.id } } } });
              const state = states.nodes.find((s) => s.type === stateType);
              if (state) {
                await linearIssue.update({ stateId: state.id });
                pushedUpdated++;
              }
            }
          } catch {
            // Continue on error
          }
        } else {
          pushedUpdated++;
        }
      }
    }
  }

  if (!options.dryRun) {
    saveBeadsIssues(discovery, updatedIssues);
    const meta = metadata || { backend: "linearctl", version: "1.0.0" };
    meta.last_sync = new Date().toISOString();
    saveBeadsMetadata(discovery, meta);
  }

  const ready = getReadyIssues(updatedIssues);

  return {
    pulled: 0,
    created: 0,
    updated: 0,
    pushed: pushedCreated + pushedUpdated,
    pushedCreated,
    pushedUpdated,
    conflicts: 0,
    readyCount: ready.length,
    totalLocal: updatedIssues.length,
    durationMs: Date.now() - startTime,
  };
}

/**
 * Bidirectional or directed sync between Linear and Beads.
 */
export async function syncBeads(
  client: LinearClient,
  discovery: BeadsDiscoveryResult,
  options: BeadsSyncOptions = {}
): Promise<BeadsSyncStats> {
  const startTime = Date.now();

  if (options.push && !options.pull) {
    return pushToLinear(client, discovery, options);
  }

  if (options.pull && !options.push) {
    return pullFromLinear(client, discovery, options);
  }

  // Default: Bidirectional (pull first, then push)
  const pullStats = await pullFromLinear(client, discovery, options);
  const pushStats = await pushToLinear(client, discovery, options);

  return {
    pulled: pullStats.pulled,
    created: pullStats.created,
    updated: pullStats.updated,
    pushed: pushStats.pushed,
    pushedCreated: pushStats.pushedCreated,
    pushedUpdated: pushStats.pushedUpdated,
    conflicts: pullStats.conflicts,
    readyCount: pushStats.readyCount,
    totalLocal: pushStats.totalLocal,
    durationMs: Date.now() - startTime,
  };
}
