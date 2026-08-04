import { makeClient } from "../client.js";
import { mine as mineCore, type MineResult } from "../core/mine.js";
import { printJson } from "../lib/output.js";

export interface MineOptions {
  team?: string[];
  all?: boolean;
  json?: boolean;
}

const HEADING: Record<string, string> = {
  started: "In progress",
  triage: "Needs triage",
  unstarted: "Up next",
  backlog: "Backlog",
  completed: "Done",
  canceled: "Canceled",
};

const PRIORITY_TAG = ["", " [urgent]", " [high]", "", ""];

/** Render the mine view as markdown-ish text. Pure — exported for tests. */
export function renderMine(result: MineResult): string {
  if (result.total === 0) return "No issues assigned to you.\n";
  const lines = [`${result.total} issue(s) assigned to you`];
  for (const group of result.groups) {
    lines.push("", `${HEADING[group.type] ?? group.type} (${group.count})`);
    for (const i of group.items) {
      lines.push(`  ${i.identifier}  ${i.title}${PRIORITY_TAG[i.priority] ?? ""}`);
    }
  }
  return lines.join("\n") + "\n";
}

/**
 * `linearctl mine [--team KEY...] [--all] [--json]` — the viewer's issues
 * grouped by state, active first. The "what am I doing" catch-up view;
 * completed/canceled only with --all.
 */
export async function mineCmd(opts: MineOptions): Promise<void> {
  const client = makeClient();
  const result = await mineCore(client, opts.team, opts.all);
  if (opts.json) {
    printJson(result);
    return;
  }
  process.stdout.write(renderMine(result));
}
