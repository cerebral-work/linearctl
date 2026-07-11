import { makeClient } from "../client.js";
import { commentsByAuthor } from "../core/comments.js";
import { sinceToDate } from "../lib/time.js";
import { printJson, printTable } from "../lib/output.js";
import { pc } from "../lib/style.js";

export interface CommentsOptions {
  author?: string;
  since?: string;
  team?: string[];
  limit?: string;
  json?: boolean;
}

/**
 * `linearctl comments --author <who> [--since 7d] [--team KEY...]` — the
 * "what changed / what did X say" scan, one query instead of a per-issue
 * sweep. Read-only. See CER-1187.
 */
export async function commentsCmd(opts: CommentsOptions): Promise<void> {
  if (!opts.author) throw new Error("comments needs --author ('me', an email, or a display name).");
  const client = makeClient();
  const rows = await commentsByAuthor(client, {
    author: opts.author,
    since: sinceToDate(opts.since ?? "7d"),
    teamKeys: opts.team,
    limit: opts.limit !== undefined ? Number(opts.limit) : undefined,
  });

  if (opts.json) {
    printJson(rows);
    return;
  }
  printTable(
    rows.map((r) => ({
      time: r.at.replace("T", " ").slice(0, 16),
      issue: r.issue,
      comment: r.body.replace(/\s+/g, " ").slice(0, 120),
    })),
    ["time", "issue", "comment"],
    (value, column) => {
      if (column === "time") return pc.dim(value);
      if (column === "issue") return pc.cyan(value);
      return value;
    },
  );
}
