import type { LinearClient } from "@linear/sdk";
import { createIssue, type CreatedIssue } from "./issues.js";

export interface BatchFileItem {
  title: string;
  team?: string;
  desc?: string;
  labels?: string[];
  project?: string;
  assignee?: string;
  priority?: number;
  milestone?: string;
  parent?: string;
}

/** Parse a JSON array or NDJSON of batch-file items (spec §7 T6 / CER-1141). */
export function parseFileBatchSpec(raw: string): BatchFileItem[] {
  const text = raw.trim();
  if (!text) return [];
  const coerce = (x: unknown, i: number): BatchFileItem => {
    if (typeof x !== "object" || x === null || typeof (x as BatchFileItem).title !== "string") {
      throw new Error(`batch item ${i}: needs at least a string "title".`);
    }
    return x as BatchFileItem;
  };
  if (text.startsWith("[")) {
    const arr = JSON.parse(text) as unknown;
    if (!Array.isArray(arr)) throw new Error("batch spec must be a JSON array or NDJSON of objects.");
    return arr.map(coerce);
  }
  return text
    .split("\n")
    .filter((l) => l.trim())
    .map((l, i) => coerce(JSON.parse(l), i));
}

export interface BatchFileOutcome {
  title: string;
  team: string;
  created?: CreatedIssue;
  error?: string;
}

/**
 * Create a batch of issues SEQUENTIALLY — deliberate: withRetry already
 * backs off per-request on RATELIMITED, and the command layer runs a
 * pre-flight quota probe so a batch aborts BEFORE burning the window (the
 * observed 32-issue-run failure mode this ticket exists for). One failed
 * item doesn't stop the rest; failures are reported per-item.
 */
export async function batchFileIssues(
  client: LinearClient,
  items: BatchFileItem[],
  defaultTeam: string | undefined,
  onProgress?: (done: number, total: number) => void,
): Promise<BatchFileOutcome[]> {
  const outcomes: BatchFileOutcome[] = [];
  for (const [i, item] of items.entries()) {
    const team = item.team ?? defaultTeam;
    if (!team) {
      outcomes.push({ title: item.title, team: "—", error: "no team (item.team or --team)" });
      continue;
    }
    try {
      const created = await createIssue(client, {
        teamKey: team,
        title: item.title,
        description: item.desc,
        projectId: item.project,
        labels: item.labels,
        assignee: item.assignee,
        priority: item.priority,
        milestone: item.milestone,
        parent: item.parent,
      });
      outcomes.push({ title: item.title, team, created });
    } catch (err) {
      outcomes.push({
        title: item.title,
        team,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    onProgress?.(i + 1, items.length);
  }
  return outcomes;
}
