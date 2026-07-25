import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export interface LoopRecipe {
  name: string;
  version: number;
  last_verified: string;
  trigger: {
    type: "issue_created" | "issue_updated" | "issue_created_or_updated" | "schedule";
    conditions?: Record<string, unknown>;
    cron?: string;
    timezone?: string;
  };
  permissions: {
    team_access: string[];
    code_intelligence: boolean;
    coding_sessions: boolean;
    web_access: boolean;
    external_sources: string[];
    allow_changes_outside_triggering_issue: boolean;
  };
  tools: string[];
  audience: string[];
  body: string;
  file: string;
}

export interface LintFinding {
  file: string;
  recipe: string;
  severity: "error" | "warning";
  message: string;
}

export interface LintResult {
  recipes: LoopRecipe[];
  findings: LintFinding[];
  valid: boolean;
}

/** Parse a YAML frontmatter block (minimal — not a full YAML parser). */
function parseFrontmatter(content: string): { frontmatter: Record<string, unknown>; body: string } | null {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return null;
  const block = match[1];
  const body = match[2];
  const data: Record<string, unknown> = {};

  // Track the current parent object + its key. Top-level keys go into `data`.
  // Indented keys (2-space) go into a nested object under the parent.
  let parentKey = "";
  let parent: Record<string, unknown> | null = null;

  let listKey = "";
  let listItems: unknown[] = [];

  const flushList = () => {
    if (listKey) {
      const target = parent ?? data;
      target[listKey] = listItems;
      listKey = "";
      listItems = [];
    }
  };

  for (const line of block.split("\n")) {
    const noComment = line.replace(/ #.*$/, "");
    if (!noComment.trim()) continue;

    const indent = noComment.match(/^(\s*)/)?.[1].length ?? 0;
    const trimmed = noComment.trim();

    // List item
    if (trimmed.startsWith("- ") || trimmed === "-") {
      if (listKey) {
        listItems.push(trimmed === "-" ? null : trimmed.slice(2));
        continue;
      }
    }

    // Intermediate key-value
    const kvMatch = trimmed.match(/^([\w_]+):\s*(.*)$/);
    if (!kvMatch) continue;

    flushList();
    const key = kvMatch[1];
    const val = kvMatch[2].trim();

    if (indent === 0) {
      // Top-level key
      parent = null;
      parentKey = "";

      if (val === "") {
        // Could be a nested object or a list — peek next lines
        data[key] = {};
        parent = data[key] as Record<string, unknown>;
        parentKey = key;
      } else if (val === "[]") {
        data[key] = [];
      } else {
        const cleaned = val.replace(/^["']|["']$/g, "");
        const num = Number(cleaned);
        data[key] = isNaN(num) || cleaned === "" ? cleaned : num;
      }
    } else {
      // Indented key — belongs to parent
      const target = parent ?? data;
      if (val === "") {
        // Nested list or nested object
        target[key] = {};
        listKey = key;
        listItems = [];
      } else if (val === "[]") {
        target[key] = [];
      } else {
        const cleaned = val.replace(/^["']|["']$/g, "");
        const num = Number(cleaned);
        target[key] = isNaN(num) || cleaned === "" ? cleaned : num;
      }
    }
  }

  flushList();
  return { frontmatter: data, body };
}

/** Load all recipes from a directory. Returns parsed recipes + their files. */
export function loadRecipes(dir: string): Array<{ recipe: LoopRecipe; file: string; raw: string }> {
  const results: Array<{ recipe: LoopRecipe; file: string; raw: string }> = [];
  const absDir = resolve(dir);

  let entries: string[];
  try {
    entries = readdirSync(absDir);
  } catch {
    return results;
  }

  for (const entry of entries) {
    if (!entry.endsWith(".md") || entry === "README.md") continue;
    const file = join(absDir, entry);
    const raw = readFileSync(file, "utf-8");
    const parsed = parseFrontmatter(raw);
    if (!parsed) continue;

    results.push({
      recipe: parsed.frontmatter as unknown as LoopRecipe,
      file,
      raw,
    });
  }

  return results;
}

const VALID_TRIGGER_TYPES = new Set([
  "issue_created",
  "issue_updated",
  "issue_created_or_updated",
  "schedule",
]);

/** Lint a single recipe against the catalog rules. */
export function lintRecipe(recipe: LoopRecipe, file: string): LintFinding[] {
  const findings: LintFinding[] = [];
  const name = recipe.name ?? file;

  // 1. Required fields
  if (!recipe.name) {
    findings.push({ file, recipe: name, severity: "error", message: "missing required field: name" });
  }
  if (recipe.version === undefined) {
    findings.push({ file, recipe: name, severity: "error", message: "missing required field: version" });
  }
  if (!recipe.last_verified) {
    findings.push({ file, recipe: name, severity: "warning", message: "missing last_verified date — staleness is invisible without it" });
  }
  if (!recipe.trigger) {
    findings.push({ file, recipe: name, severity: "error", message: "missing required field: trigger" });
  }
  if (!recipe.permissions) {
    findings.push({ file, recipe: name, severity: "error", message: "missing required field: permissions" });
  }

  // 2. Trigger type valid
  if (recipe.trigger && !VALID_TRIGGER_TYPES.has(recipe.trigger.type)) {
    findings.push({
      file,
      recipe: name,
      severity: "error",
      message: `invalid trigger type: ${recipe.trigger.type} (expected one of ${[...VALID_TRIGGER_TYPES].join(", ")})`,
    });
  }

  // 3. Schedule needs cron
  if (recipe.trigger?.type === "schedule" && !recipe.trigger.cron) {
    findings.push({ file, recipe: name, severity: "error", message: "schedule trigger requires a cron field" });
  }

  // 4. team_access should not be ["all"] or empty (least privilege)
  if (recipe.permissions?.team_access) {
    const teams = recipe.permissions.team_access;
    if (teams.length === 0) {
      findings.push({ file, recipe: name, severity: "warning", message: "team_access is empty — loop has no team scope" });
    }
  }

  // 5. web_access is high-risk
  if (recipe.permissions?.web_access === true) {
    findings.push({
      file,
      recipe: name,
      severity: "warning",
      message: "web_access is enabled — this can send workspace content to external services",
    });
  }

  // 6. coding_sessions is high-autonomy
  if (recipe.permissions?.coding_sessions === true) {
    findings.push({
      file,
      recipe: name,
      severity: "warning",
      message: "coding_sessions is enabled — loop can start PRs autonomously",
    });
  }

  // 7. allow_changes_outside_triggering_issue should be false by default
  if (recipe.permissions?.allow_changes_outside_triggering_issue === true && recipe.trigger?.type !== "schedule") {
    findings.push({
      file,
      recipe: name,
      severity: "warning",
      message: "allow_changes_outside_triggering_issue is true on a non-schedule trigger — loop can write to any issue in scope",
    });
  }

  // 8. last_verified staleness check (>90 days)
  if (recipe.last_verified) {
    const verified = new Date(recipe.last_verified);
    const daysSince = (Date.now() - verified.getTime()) / (1000 * 60 * 60 * 24);
    if (daysSince > 90) {
      findings.push({
        file,
        recipe: name,
        severity: "warning",
        message: `last_verified is ${Math.round(daysSince)}d old — re-verify against the Linear Loops UI`,
      });
    }
  }

  // 9. Body should have negative constraints ("Does NOT")
  if (recipe.body && !/do not|does not|never/i.test(recipe.body)) {
    findings.push({
      file,
      recipe: name,
      severity: "warning",
      message: "body has no negative constraints (e.g. 'Do NOT change...') — bound the loop's autonomy",
    });
  }

  return findings;
}

/** Find the default loop-recipes directories (repo-local + user-global). */
export function recipeDirs(): string[] {
  const dirs: string[] = [];
  const cwdRecipes = join(process.cwd(), ".linearctl", "loop-recipes");
  dirs.push(cwdRecipes);
  const home = process.env.HOME;
  if (home) {
    dirs.push(join(home, ".config", "linearctl", "loop-recipes"));
  }
  return dirs.filter((d) => {
    try {
      return statSync(d).isDirectory();
    } catch {
      return false;
    }
  });
}

/**
 * Lint all recipes in the given directories. Returns recipes + findings +
 * overall validity (valid = no error-severity findings).
 */
export function lintAll(dirs: string[]): LintResult {
  const allRecipes: LoopRecipe[] = [];
  const allFindings: LintFinding[] = [];

  for (const dir of dirs) {
    const loaded = loadRecipes(dir);
    for (const { recipe, file } of loaded) {
      allRecipes.push(recipe);
      allFindings.push(...lintRecipe(recipe, file));
    }
  }

  return {
    recipes: allRecipes,
    findings: allFindings,
    valid: !allFindings.some((f) => f.severity === "error"),
  };
}
