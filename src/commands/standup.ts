import { makeClient } from "../client.js";
import { digest as digestCore, type DigestResult } from "../core/grooming.js";
import { sinceToDate } from "../lib/time.js";
import { printJson } from "../lib/output.js";

export interface StandupOptions {
  team?: string[];
  since?: string;
  json?: boolean;
}

const SECTION: Record<string, string> = {
  completed: "Done",
  started: "In progress",
  unstarted: "Up next",
  triage: "Needs triage",
};

/** Render a digest as standup markdown. Pure — exported for tests. */
export function renderStandup(d: DigestResult, since: string): string {
  const lines = [`**Standup** · last ${since} · ${d.total} issue(s) touched`];
  for (const group of d.groups) {
    const heading = SECTION[group.type];
    if (!heading) continue; // backlog/canceled noise stays out of a standup
    lines.push("", `**${heading}** (${group.count})`);
    for (const i of group.items) {
      lines.push(`- ${i.identifier} ${i.title}${i.assignee ? ` — ${i.assignee}` : ""}`);
    }
  }
  return lines.join("\n") + "\n";
}

/**
 * `linearctl standup [--team KEY...] [--since 24h]` — the digest, rendered as
 * a standup (Done / In progress / Up next / Needs triage). Markdown to
 * stdout; posting anywhere (Slack etc.) is deliberately NOT implemented —
 * spec §7.5 gates any send on the operator, so this composes with whatever
 * operator-approved sender exists (pipe it). See CER-1147.
 */
export async function standup(opts: StandupOptions): Promise<void> {
  const client = makeClient();
  const since = opts.since ?? "24h";
  const result = await digestCore(client, sinceToDate(since), opts.team);
  if (opts.json) {
    printJson(result);
    return;
  }
  process.stdout.write(renderStandup(result, since));
}
