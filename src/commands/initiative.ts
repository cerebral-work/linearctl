import { makeClient } from "../client.js";
import { initiatives as initiativesCore, type InitiativeRollup } from "../core/initiatives.js";
import { printJson } from "../lib/output.js";

export interface InitiativeOptions {
  all?: boolean;
  json?: boolean;
}

function pct(progress: number | null): string {
  return progress === null ? "—" : `${Math.round(progress * 100)}%`;
}

/** Render the initiative rollup. Pure — exported for tests. */
export function renderInitiatives(rollups: InitiativeRollup[]): string {
  if (rollups.length === 0) return "No initiatives.\n";
  const lines: string[] = [];
  for (const init of rollups) {
    const due = init.targetDate ? ` · due ${init.targetDate}` : "";
    lines.push(
      `${init.name} [${init.status}] · ${pct(init.progress)} · ${init.projects.length} project(s)${due}`,
    );
    for (const p of init.projects) {
      const pdue = p.targetDate ? ` · due ${p.targetDate}` : "";
      lines.push(`  ${pct(p.progress).padStart(4)}  ${p.name} (${p.state})${pdue}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

/**
 * `linearctl initiative [--all] [--json]` — initiative rollup: projects and
 * mean progress per initiative. Completed initiatives only with --all.
 */
export async function initiativeCmd(opts: InitiativeOptions): Promise<void> {
  const client = makeClient();
  const rollups = await initiativesCore(client, opts.all);
  if (opts.json) {
    printJson(rollups);
    return;
  }
  process.stdout.write(renderInitiatives(rollups));
}
