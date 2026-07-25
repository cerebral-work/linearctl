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
    process.stderr.write(
      "no loop-recipes directory found (expected .linearctl/loop-recipes/ or ~/.config/linearctl/loop-recipes/).\n",
    );
    process.exit(2);
  }

  const result = lintAll(dirs);

  if (opts.json) {
    printJson(result);
    return;
  }

  // Human output
  if (result.recipes.length === 0) {
    process.stdout.write("no recipes found.\n");
    process.exit(2);
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

  process.exit(errors.length > 0 ? 1 : 0);
}
