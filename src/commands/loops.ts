import { notFoundError, usageError } from "../lib/errors.js";
import { lintAll, recipeDirs, type LintFinding } from "../core/loop-recipes.js";
import { printJson } from "../lib/output.js";
import { pc } from "../lib/style.js";

export interface LoopsLintOptions {
  json?: boolean;
}

/**
 * `linearctl loops lint` — validate loop recipe files in
 * `.linearctl/loop-recipes/` and `~/.config/linearctl/loop-recipes/`.
 * Checks: required fields present, trigger type valid, schedule has cron,
 * least-privilege warnings (web_access, coding_sessions, broad write scope),
 * last_verified staleness (>90d), body has negative constraints.
 * Exit 0 if valid (no errors), 1 if errors, 2 if no recipes found.
 */
export async function loopsLint(opts: LoopsLintOptions): Promise<void> {
  const dirs = recipeDirs();
  if (dirs.length === 0) {
    throw notFoundError("no loop-recipes directory found (expected .linearctl/loop-recipes/ or ~/.config/linearctl/loop-recipes/).");
  }

  const result = lintAll(dirs);

  if (result.recipes.length === 0) throw notFoundError("no recipes found.");
  if (opts.json) {
    printJson(result);
    if (!result.valid) throw usageError("loop recipes failed validation; inspect findings on stdout.");
    return;
  }

  const errors = result.findings.filter((f) => f.severity === "error");
  const warnings = result.findings.filter((f) => f.severity === "warning");

  process.stdout.write(
    `${pc.bold(`${result.recipes.length}`)} recipe(s), ` +
      `${errors.length} error(s), ${warnings.length} warning(s)\n`,
  );

  for (const f of result.findings) {
    const icon = f.severity === "error" ? pc.red("✖") : pc.yellow("⚠");
    process.stdout.write(`  ${icon} ${f.recipe}: ${f.message}\n`);
  }

  if (result.valid) {
    process.stdout.write(`${pc.green("✓")} all recipes valid\n`);
  }

  if (errors.length) throw usageError("loop recipes failed validation; inspect findings on stdout.");
}
