import { makeClient } from "../client.js";
import { releaseNotes, renderReleaseNotes } from "../core/release-notes.js";
import { sinceToDate } from "../lib/time.js";
import { printJson } from "../lib/output.js";

export interface ReleaseNotesOptions {
  since?: string;
  until?: string;
  team?: string[];
  project?: string;
  json?: boolean;
}

/** Accept a look-back window (7d) or an ISO date (2026-07-01). */
const parsePoint = (spec: string): Date => {
  if (/^\d{4}-\d{2}-\d{2}/.test(spec)) {
    const d = new Date(spec);
    if (Number.isNaN(d.getTime())) throw new Error(`invalid date: ${JSON.stringify(spec)}`);
    return d;
  }
  return sinceToDate(spec);
};

/**
 * `linearctl release-notes [--since 7d|YYYY-MM-DD] [--until YYYY-MM-DD]
 * [--team KEY...] [--project REF]` — markdown notes from issues completed in
 * the range, grouped by label. Feeds cut-release / linear-release (spec §7.4,
 * CER-1146). Read-only; markdown to stdout so it pipes straight into a
 * CHANGELOG or gh release note.
 */
export async function releaseNotesCmd(opts: ReleaseNotesOptions): Promise<void> {
  const client = makeClient();
  const result = await releaseNotes(client, {
    from: parsePoint(opts.since ?? "7d"),
    until: opts.until ? parsePoint(opts.until) : undefined,
    teamKeys: opts.team,
    project: opts.project,
  });

  if (opts.json) {
    printJson(result);
    return;
  }
  process.stdout.write(renderReleaseNotes(result));
}
