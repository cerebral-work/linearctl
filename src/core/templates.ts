import { readdirSync, readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, basename } from "node:path";
import { parseTemplate, type ParsedTemplate } from "../lib/template.js";

export interface TemplateEntry {
  name: string;
  path: string;
  source: "repo" | "user";
}

const REPO_DIR = ".linearctl/templates";
const LNR_REPO_DIR = ".lnr/templates";
const userDir = (): string => join(homedir(), ".config/linearctl/templates");
const lnrUserDir = (): string => join(homedir(), ".config/lnr/templates");

/**
 * Discover templates: repo-local `.lnr/templates/*.md` and `.linearctl/templates/*.md`
 * override user-global `~/.config/lnr/templates/*.md` and `~/.config/linearctl/templates/*.md`
 * on name collision.
 */
export function listTemplates(cwd: string = process.cwd()): TemplateEntry[] {
  const byName = new Map<string, TemplateEntry>();
  const scan = (dir: string, source: "repo" | "user"): void => {
    if (!existsSync(dir)) return;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".md")) continue;
      const name = basename(f, ".md");
      if (byName.has(name)) continue;
      byName.set(name, { name, path: join(dir, f), source });
    }
  };
  scan(join(cwd, LNR_REPO_DIR), "repo");
  scan(join(cwd, REPO_DIR), "repo");
  scan(lnrUserDir(), "user");
  scan(userDir(), "user");
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function loadTemplate(name: string, cwd: string = process.cwd()): ParsedTemplate {
  const entry = listTemplates(cwd).find((t) => t.name === name);
  if (!entry) {
    const known = listTemplates(cwd).map((t) => t.name);
    throw new Error(
      `no template ${JSON.stringify(name)} — known: ${known.length ? known.join(", ") : `(none; add ${REPO_DIR}/${name}.md)`}.`,
    );
  }
  return parseTemplate(readFileSync(entry.path, "utf8"), entry.name);
}
