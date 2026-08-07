import { makeClient } from "../client.js";
import { createIssue } from "../core/issues.js";
import { readStdinFor } from "../lib/io.js";
import { printJson } from "../lib/output.js";
import { withSpinner } from "../lib/spinner.js";
import { buildStoryDescription } from "../lib/story.js";

export interface ParkOptions {
  team?: string;
  project?: string;
  persona?: string;
  want?: string;
  why?: string;
  accept?: string;
  label?: string[];
  json?: boolean;
}

const PARK_LABEL = "user-story";

/**
 * `linearctl park <title> --team CER` — collect, don't commit: file straight
 * into the team's Backlog state with an optional user-story scaffold and an
 * auto-created `user-story` label. See docs/features/park.md (CER-1557).
 */
export async function park(title: string, opts: ParkOptions): Promise<void> {
  if (!opts.team) throw new Error("park needs --team <key> (e.g. CER).");
  const client = makeClient();

  const acceptRaw = opts.accept === "-" ? await readStdinFor("--accept -") : opts.accept;
  const description = buildStoryDescription({
    title,
    persona: opts.persona,
    want: opts.want,
    why: opts.why,
    acceptance: acceptRaw ? acceptRaw.split("\n") : undefined,
  });

  const issue = await withSpinner("Parking story…", () =>
    createIssue(client, {
      teamKey: opts.team as string,
      title,
      description,
      projectId: opts.project,
      labels: opts.label,
      stateType: "backlog",
      ensureLabels: [PARK_LABEL],
    }),
  );

  if (opts.json) {
    printJson({ ...issue, state: "Backlog", label: PARK_LABEL });
    return;
  }
  process.stdout.write(
    `parked ${issue.identifier} [Backlog, ${PARK_LABEL}]: ${issue.title}\n  url: ${issue.url}\n`,
  );
}
