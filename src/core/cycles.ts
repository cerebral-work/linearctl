import type { LinearClient } from "@linear/sdk";
import { LinearDocument } from "@linear/sdk";
import { withRetry } from "../lib/retry.js";
import { collectIssuesFlat, type FlatIssueNode } from "./issues-query.js";
import { UUID_RE } from "./projects.js";

const CYCLE_RESOLVE_QUERY = /* GraphQL */ `
  query ResolveCycle($team: String!) {
    teams(filter: { key: { eq: $team } }) {
      nodes {
        key
        activeCycle { id number }
        cycles(first: 100) { nodes { id number startsAt } }
      }
    }
  }
`;

/**
 * Resolve a `--cycle` ref (scoped to a team) to a cycle id, or `null` to remove.
 * Accepts: a cycle UUID, a cycle number, `current`/`active`, `next`, `none`.
 * `next` = the earliest cycle starting in the future — resolvable even between
 * cycles (when `activeCycle` is null). Fixes OPS-593 (previously raw GraphQL).
 */
export async function resolveCycleId(
  client: LinearClient,
  teamKey: string,
  ref: string,
): Promise<string | null> {
  const lc = ref.trim().toLowerCase();
  if (lc === "none" || lc === "") return null;
  if (UUID_RE.test(ref.trim())) return ref.trim();

  type Node = {
    key: string;
    activeCycle: { id: string; number: number } | null;
    cycles: { nodes: Array<{ id: string; number: number; startsAt: string }> };
  };
  const res = await withRetry(() =>
    client.client.rawRequest<{ teams: { nodes: Node[] } }, { team: string }>(
      CYCLE_RESOLVE_QUERY,
      { team: teamKey },
    ),
  );
  const team = res.data?.teams.nodes[0];
  if (!team) throw new Error(`no team matching ${JSON.stringify(teamKey)} for --cycle.`);
  const all = team.cycles.nodes;
  if (!all.length && !team.activeCycle) {
    throw new Error(`team ${teamKey} has no cycles (cycles may be disabled).`);
  }

  if (lc === "current" || lc === "active") {
    if (!team.activeCycle) {
      throw new Error(`team ${teamKey} has no active cycle right now — use 'next' or a cycle number.`);
    }
    return team.activeCycle.id;
  }
  if (lc === "next") {
    const now = Date.now();
    const future = all
      .filter((c) => new Date(c.startsAt).getTime() > now)
      .sort((a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime());
    if (!future.length) throw new Error(`team ${teamKey} has no upcoming cycle.`);
    return future[0].id;
  }
  const num = Number(lc);
  if (!Number.isInteger(num)) {
    throw new Error(
      `--cycle ${JSON.stringify(ref)} is not a number, 'current', 'next', 'none', or a cycle id.`,
    );
  }
  const match =
    all.find((c) => c.number === num) ??
    (team.activeCycle?.number === num ? team.activeCycle : undefined);
  if (!match) throw new Error(`team ${teamKey} has no cycle number ${num}.`);
  return match.id;
}

export interface CycleRef {
  id: string;
  number: number;
  startsAt: string;
  endsAt: string;
}

export interface CycleBucket {
  issues: number;
  points: number;
  identifiers: string[];
}

export interface CycleReview {
  team: string;
  which: "active" | "previous";
  cycle: CycleRef;
  daysRemaining: number;
  scope: CycleBucket;
  done: CycleBucket;
  inProgress: CycleBucket;
  unstarted: CycleBucket;
  atRisk: Array<{ identifier: string; reason: string }>;
  carryOver: {
    fromCycle: number;
    issues: number;
    doneSince: number;
    stillOpen: string[];
  } | null;
}

const TEAM_CYCLES_QUERY = /* GraphQL */ `
  query TeamCycles($team: String!) {
    teams(filter: { key: { eq: $team } }) {
      nodes {
        key
        activeCycle {
          id
          number
          startsAt
          endsAt
        }
        cycles(filter: { isPrevious: { eq: true } }) {
          nodes {
            id
            number
            startsAt
            endsAt
          }
        }
      }
    }
  }
`;

const CARRY_OVER_QUERY = /* GraphQL */ `
  query CarryOver($id: String!) {
    cycle(id: $id) {
      number
      uncompletedIssuesUponClose(first: 50) {
        nodes {
          identifier
          state {
            type
          }
        }
      }
    }
  }
`;

const DAY_MS = 86_400_000;

const bucket = (issues: FlatIssueNode[]): CycleBucket => ({
  issues: issues.length,
  points: issues.reduce((s, i) => s + (i.estimate ?? 0), 0),
  identifiers: issues.map((i) => i.identifier),
});

/**
 * Review a team's cycle: scope/done/in-progress buckets with points, at-risk
 * (unstarted inside the risk window), and carry-over from the previous
 * cycle's `uncompletedIssuesUponClose` (their CURRENT states show what got
 * finished since). Read-only. See docs/features/cycle.md (CER-1143).
 */
export async function cycleReview(
  client: LinearClient,
  opts: { teamKey: string; previous?: boolean; riskWindowDays?: number; now?: Date },
): Promise<CycleReview> {
  type Vars = Record<string, unknown> & { team: string };
  const vars: Vars = { team: opts.teamKey };
  const res = await withRetry(() =>
    client.client.rawRequest<
      {
        teams: {
          nodes: Array<{
            key: string;
            activeCycle: CycleRef | null;
            cycles: { nodes: CycleRef[] };
          }>;
        };
      },
      Vars
    >(TEAM_CYCLES_QUERY, vars),
  );
  const team = res.data?.teams.nodes[0];
  if (!team) throw new Error(`no team matching ${JSON.stringify(opts.teamKey)}.`);
  const previous = team.cycles.nodes[0] ?? null;
  const cycle = opts.previous ? previous : team.activeCycle;
  if (!cycle) {
    throw new Error(
      `team ${team.key} has no ${opts.previous ? "previous" : "active"} cycle (cycles may be disabled).`,
    );
  }

  const issues = await collectIssuesFlat(
    client,
    { cycle: { id: { eq: cycle.id } } } as LinearDocument.IssueFilter,
  );
  const done = issues.filter((i) => i.state?.type === "completed");
  const inProgress = issues.filter((i) => i.state?.type === "started");
  const unstarted = issues.filter(
    (i) => !["completed", "canceled", "started"].includes(i.state?.type ?? ""),
  );

  const now = opts.now ?? new Date();
  const daysRemaining = Math.max(
    0,
    Math.ceil((new Date(cycle.endsAt).getTime() - now.getTime()) / DAY_MS),
  );
  const risk = opts.riskWindowDays ?? 2;
  const atRisk =
    daysRemaining <= risk
      ? unstarted.map((i) => ({
          identifier: i.identifier,
          reason: `unstarted, ${daysRemaining}d left`,
        }))
      : [];

  let carryOver: CycleReview["carryOver"] = null;
  const carrySource = opts.previous ? null : previous;
  if (carrySource) {
    type CVars = Record<string, unknown> & { id: string };
    const cvars: CVars = { id: carrySource.id };
    const cres = await withRetry(() =>
      client.client.rawRequest<
        {
          cycle: {
            number: number;
            uncompletedIssuesUponClose: {
              nodes: Array<{ identifier: string; state: { type: string } | null }>;
            };
          } | null;
        },
        CVars
      >(CARRY_OVER_QUERY, cvars),
    );
    const nodes = cres.data?.cycle?.uncompletedIssuesUponClose.nodes ?? [];
    const stillOpen = nodes
      .filter((n) => !["completed", "canceled"].includes(n.state?.type ?? ""))
      .map((n) => n.identifier);
    carryOver = {
      fromCycle: carrySource.number,
      issues: nodes.length,
      doneSince: nodes.length - stillOpen.length,
      stillOpen,
    };
  }

  return {
    team: team.key,
    which: opts.previous ? "previous" : "active",
    cycle,
    daysRemaining,
    scope: bucket(issues),
    done: bucket(done),
    inProgress: bucket(inProgress),
    unstarted: bucket(unstarted),
    atRisk,
    carryOver,
  };
}
