import type { LinearClient } from "@linear/sdk";
import { scoreCandidates } from "../lib/similarity.js";
import { collectIssuesFlat, projectClause, scopedTeams } from "./issues-query.js";

export interface DupcheckOptions {
  teamKeys?: string[];
  project?: string;
  threshold?: number;
  limit?: number;
}

export interface DupMatch {
  identifier: string;
  score: number;
  title: string;
  url: string;
}

export interface DupcheckResult {
  query: string;
  threshold: number;
  matches: DupMatch[];
}

export const DUPCHECK_DEFAULT_THRESHOLD = 0.85;

/**
 * Score a candidate title against a team's active issues (same active-state
 * scope as `triage`). Read-only — the pre-file guard; the human decides.
 * See docs/features/dupcheck.md (CER-1559).
 */
export async function dupcheck(
  client: LinearClient,
  title: string,
  opts: DupcheckOptions = {},
): Promise<DupcheckResult> {
  const threshold = opts.threshold ?? DUPCHECK_DEFAULT_THRESHOLD;
  const teams = scopedTeams(opts.teamKeys);
  const issues = await collectIssuesFlat(client, {
    ...(teams ? { team: { key: { in: teams } } } : {}),
    and: [
      { state: { type: { nin: ["completed", "canceled"] } } },
      ...projectClause(opts.project),
    ],
  });

  const matches = scoreCandidates(
    title,
    issues,
    (i) => i.title,
    threshold,
    opts.limit ?? 5,
  ).map(({ item, score }) => ({
    identifier: item.identifier,
    score: Math.round(score * 100) / 100,
    title: item.title,
    url: item.url,
  }));

  return { query: title, threshold, matches };
}
