import { makeClient } from "../client.js";
import { digest as digestCore, type DigestResult } from "../core/grooming.js";
import { sinceToDate } from "../lib/time.js";
import { printJson } from "../lib/output.js";

export interface StandupOptions {
  team?: string[];
  since?: string;
  json?: boolean;
  slack?: string;
  apply?: boolean;
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
 * `linearctl standup [--team KEY...] [--since 24h] [--slack <url> --apply]` —
 * the digest, rendered as a standup (Done / In progress / Up next / Needs
 * triage). Markdown to stdout by default. With `--slack`, renders and previews
 * the Slack payload; `--slack --apply` actually posts to the webhook.
 *
 * The Slack webhook URL comes from `--slack <url>` or the `LINEARCTL_SLACK_WEBHOOK`
 * env var. Never auto-posts — always requires `--apply`. See CER-1730.
 */
export async function standup(opts: StandupOptions): Promise<void> {
  const client = makeClient();
  const since = opts.since ?? "24h";
  const result = await digestCore(client, sinceToDate(since), opts.team);

  // Slack send — gated on --slack (or env) and --apply (never auto-posts).
  // Checked before the --json early-return so `--json --slack --apply` still posts.
  const webhookUrl = opts.slack ?? process.env.LINEARCTL_SLACK_WEBHOOK;
  const markdown = renderStandup(result, since);

  if (opts.json) {
    printJson(result);
  } else {
    process.stdout.write(markdown);
  }

  if (!webhookUrl) return;
  if (!opts.apply) {
    process.stderr.write(
      `[dry-run] would post standup to Slack (${webhookUrl.slice(0, 20)}…). Re-run with --apply to send.\n`,
    );
    return;
  }

  // Slack incoming webhooks: POST a JSON body with a `text` field.
  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: markdown }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "(no body)");
    throw new Error(`Slack webhook returned ${res.status}: ${body}`);
  }
  process.stderr.write(`standup posted to Slack.\n`);
}
