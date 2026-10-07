import { makeClient } from "../client.js";
import { search as searchCore } from "../core/search.js";
import { printJson, printTable } from "../lib/output.js";
import { pc } from "../lib/style.js";

export interface SearchCmdOptions {
  team?: string[];
  state?: string;
  label?: string[];
  assignee?: string;
  project?: string;
  milestone?: string;
  priority?: string;
  text?: string;
  updatedSince?: string;
  createdSince?: string;
  json?: boolean;
  /** Read from local SQLite cache instead of live Linear API. */
  cache?: boolean;
}

const PRIORITY_NAMES = ["—", "urgent", "high", "medium", "low"];

/**
 * `linearctl search [--team KEY...] [--state done] [--label bug] …` — the
 * general issue query the purpose-built sweeps (triage/stale/digest) are
 * special cases of. Delegates to `core.search`; this layer only formats.
 * See docs/features/search.md (CER-1560).
 */
export async function searchCmd(opts: SearchCmdOptions): Promise<void> {
  const useCache = opts.cache ?? (process.env.LINEARCTL_CACHE === "true");

  let items: Array<{
    identifier: string;
    state: string;
    priority: number;
    assignee: string | null;
    title: string;
  }>;

  if (useCache) {
    const { openCacheDb } = await import("../core/cache/db.js");
    const { searchCachedIssues } = await import("../core/cache/query.js");
    const cache = openCacheDb();
    try {
      const cached = searchCachedIssues(cache, {
        teamKeys: opts.team,
        state: opts.state,
        labels: opts.label,
        assignee: opts.assignee,
        project: opts.project,
        milestone: opts.milestone,
        priority: opts.priority,
        text: opts.text,
        updatedSince: opts.updatedSince,
        createdSince: opts.createdSince,
      });
      items = cached.map((c) => ({
        identifier: c.identifier,
        state: c.state,
        priority: c.priority,
        assignee: c.assignee ?? null,
        title: c.title,
      }));
    } finally {
      cache.close();
    }
  } else {
    const client = makeClient();
    items = await searchCore(client, {
      teamKeys: opts.team,
      state: opts.state,
      labels: opts.label,
      assignee: opts.assignee,
      project: opts.project,
      milestone: opts.milestone,
      priority: opts.priority,
      text: opts.text,
      updatedSince: opts.updatedSince,
      createdSince: opts.createdSince,
    });
  }

  if (opts.json) {
    printJson(items);
    return;
  }

  printTable(
    items.map((i) => ({
      identifier: i.identifier,
      state: i.state,
      prio: PRIORITY_NAMES[i.priority] ?? String(i.priority),
      assignee: i.assignee ?? "—",
      title: i.title,
    })),
    ["identifier", "state", "prio", "assignee", "title"],
    (value, column, row) => {
      if (column === "identifier") return pc.cyan(value);
      if (column === "prio" && row.prio === "urgent") return pc.red(value);
      if (column === "prio" && row.prio === "high") return pc.yellow(value);
      if (column === "assignee" && row.assignee === "—") return pc.dim(value);
      return value;
    },
  );
}
