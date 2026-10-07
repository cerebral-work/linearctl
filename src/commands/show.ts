import { notFoundError, usageError } from "../lib/errors.js";
import { makeClient } from "../client.js";
import { getIssue, renderIssueDetail, type IssueDetail } from "../core/issues.js";
import { printJson } from "../lib/output.js";
import { isInteractive } from "../lib/interactive.js";
import { promptIssuePick } from "../lib/prompts.js";

export interface ShowOptions {
  team?: string[];
  json?: boolean;
  cache?: boolean;
}

/**
 * `linearctl show <id>` — read one issue in full (metadata + description).
 * Delegates to `core.getIssue`. At a TTY with no id, offers a fuzzy picker
 * over recently updated active issues. See docs/spec.md §6.
 */
export async function show(id: string | undefined, opts: ShowOptions): Promise<void> {
  const useCache = opts.cache ?? (process.env.LINEARCTL_CACHE === "true");

  if (useCache) {
    if (!id) throw usageError("show --cache needs an <id> (e.g. CER-123).");
    const { openCacheDb } = await import("../core/cache/db.js");
    const { getCachedIssue } = await import("../core/cache/query.js");
    const cache = openCacheDb();
    try {
      const cached = getCachedIssue(cache, id);
      if (!cached) {
        throw notFoundError(`${id}: issue not found in local cache.`);
      }
      let labels: string[] = [];
      try {
        labels = JSON.parse(cached.labelsJson || "[]");
      } catch {
        labels = [];
      }
      const detail: IssueDetail = {
        id: cached.id,
        identifier: cached.identifier,
        title: cached.title,
        url: cached.url,
        state: cached.stateName,
        stateType: cached.stateType,
        assignee: cached.assigneeName,
        priority: cached.priorityLabel ?? (cached.priority ? `P${cached.priority}` : "No priority"),
        project: cached.projectName,
        milestone: cached.projectMilestoneId
          ? { id: cached.projectMilestoneId, name: cached.projectMilestoneId, targetDate: null }
          : null,
        labels,
        parent: cached.parentId,
        description: cached.description || null,
        createdAt: cached.createdAt,
        updatedAt: cached.updatedAt,
      };
      if (opts.json) {
        printJson(detail);
        return;
      }
      process.stdout.write(renderIssueDetail(detail));
      return;
    } finally {
      cache.close();
    }
  }

  const client = makeClient();
  if (!id && isInteractive(opts.json)) {
    id = await promptIssuePick(client, "Show which issue?", opts.team);
  }
  if (!id) throw usageError("show needs an <id> (e.g. CER-123).");
  const detail = await getIssue(client, id);
  if (opts.json) {
    printJson(detail);
    return;
  }
  process.stdout.write(renderIssueDetail(detail));
}
