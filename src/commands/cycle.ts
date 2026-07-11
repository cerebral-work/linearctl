import { makeClient } from "../client.js";
import { cycleReview, type CycleBucket } from "../core/cycles.js";
import { printJson } from "../lib/output.js";
import { pc } from "../lib/style.js";

export interface CycleOptions {
  team?: string;
  previous?: boolean;
  riskWindow?: string;
  json?: boolean;
}

const bar = (done: number, total: number, width = 12): string => {
  const filled = total === 0 ? 0 : Math.round((done / total) * width);
  return "█".repeat(filled) + "░".repeat(width - filled);
};

const pts = (b: CycleBucket): string =>
  b.points ? `${b.issues} issues · ${b.points} pts` : `${b.issues} issues`;

/**
 * `linearctl cycle --team TOD [--previous] [--risk-window 2]` — current-cycle
 * review: scope, burn-down, at-risk, carry-over. Read-only. Roadmap T8 /
 * docs/features/cycle.md (CER-1143).
 */
export async function cycleCmd(opts: CycleOptions): Promise<void> {
  if (!opts.team) throw new Error("cycle needs --team <key> (a team with cycles enabled).");
  const client = makeClient();
  const r = await cycleReview(client, {
    teamKey: opts.team,
    previous: opts.previous,
    riskWindowDays: opts.riskWindow !== undefined ? Number(opts.riskWindow) : undefined,
  });

  if (opts.json) {
    printJson(r);
    return;
  }

  const span = `${r.cycle.startsAt.slice(0, 10)} → ${r.cycle.endsAt.slice(0, 10)}`;
  const pct = r.scope.issues ? Math.round((r.done.issues / r.scope.issues) * 100) : 0;
  process.stdout.write(
    `${pc.bold(`${r.team} · Cycle ${r.cycle.number}`)} (${span}) · ${r.daysRemaining} day(s) remaining\n\n` +
      `  scope    ${pts(r.scope)}\n` +
      `  done     ${pts(r.done)}   ${pc.green(bar(r.done.issues, r.scope.issues))}  ${pct}%\n` +
      `  started  ${pts(r.inProgress)}\n` +
      `  unstarted ${pts(r.unstarted)}\n`,
  );
  if (r.atRisk.length) {
    process.stdout.write(
      `\n${pc.red(`at risk (${r.atRisk.length})`)}: ${r.atRisk.map((a) => a.identifier).join(", ")}\n`,
    );
  }
  if (r.carryOver) {
    process.stdout.write(
      `\ncarry-over from cycle ${r.carryOver.fromCycle}: ${r.carryOver.issues} uncompleted at close, ` +
        `${r.carryOver.doneSince} done since, ${r.carryOver.stillOpen.length} still open` +
        (r.carryOver.stillOpen.length
          ? `\n  still open: ${r.carryOver.stillOpen.slice(0, 10).join(", ")}${r.carryOver.stillOpen.length > 10 ? ", …" : ""}`
          : "") +
        "\n",
    );
  }
}
