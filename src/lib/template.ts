/**
 * Issue templates (docs/features/template.md, CER-1562). Pure parsing +
 * substitution — file discovery lives in core/templates.ts.
 *
 * Format: markdown with a minimal frontmatter block (deliberately not full
 * YAML — no dep): `key: value` lines plus `labels: [a, b]`. The markdown BODY
 * below the closing `---` is the description template. (Deviation from the
 * proposal sketch, which nested the description inside frontmatter — a
 * template should be a readable markdown file.)
 *
 * Variables: `{{ name }}` and `{{ name | "default" }}`. Flat substitution
 * only — no conditionals, by design.
 */

export interface ParsedTemplate {
  name: string;
  title: string;
  labels: string[];
  body: string;
}

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?/;
const VAR_RE = /\{\{\s*([A-Za-z_][\w-]*)\s*(?:\|\s*"([^"]*)")?\s*\}\}/g;

export function parseTemplate(raw: string, fallbackName: string): ParsedTemplate {
  const fm = raw.match(FRONTMATTER_RE);
  if (!fm) throw new Error("template has no frontmatter block (--- … ---).");
  const fields = new Map<string, string>();
  for (const line of fm[1].split("\n")) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const m = line.match(/^(\w[\w-]*):\s*(.*)$/);
    if (!m) throw new Error(`bad frontmatter line: ${JSON.stringify(line)}`);
    fields.set(m[1], m[2].trim());
  }
  const title = fields.get("title")?.replace(/^"(.*)"$/, "$1");
  if (!title) throw new Error('template frontmatter needs a `title:` field.');
  const labelsRaw = fields.get("labels") ?? "";
  const labels = labelsRaw
    .replace(/^\[|\]$/g, "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return {
    name: fields.get("name") ?? fallbackName,
    title,
    labels,
    body: raw.slice(fm[0].length).trim(),
  };
}

export interface TemplateVarSpec {
  name: string;
  default?: string;
}

/** Every distinct variable a template references, with any declared default. */
export function templateVars(t: ParsedTemplate): TemplateVarSpec[] {
  const seen = new Map<string, TemplateVarSpec>();
  for (const text of [t.title, t.body]) {
    for (const m of text.matchAll(VAR_RE)) {
      const existing = seen.get(m[1]);
      // A default anywhere satisfies the variable everywhere.
      if (!existing || (existing.default === undefined && m[2] !== undefined)) {
        seen.set(m[1], { name: m[1], ...(m[2] !== undefined ? { default: m[2] } : {}) });
      }
    }
  }
  return [...seen.values()];
}

/**
 * Substitute variables into title + body. Fails loud, listing every variable
 * that has neither a supplied value nor a default (pickLabelIds convention).
 */
export function renderTemplate(
  t: ParsedTemplate,
  vars: Record<string, string>,
): { title: string; description: string | undefined } {
  const missing = templateVars(t)
    .filter((v) => vars[v.name] === undefined && v.default === undefined)
    .map((v) => v.name);
  if (missing.length) {
    throw new Error(
      `missing template variable(s): ${missing.join(", ")} — pass --var ${missing[0]}=…`,
    );
  }
  const sub = (text: string): string =>
    text.replace(VAR_RE, (_, name: string, def?: string) => vars[name] ?? def ?? "");
  const description = sub(t.body);
  return { title: sub(t.title), description: description || undefined };
}

/** Parse repeatable `--var key=value` flags. */
export function parseVarFlags(flags: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of flags) {
    const i = f.indexOf("=");
    if (i <= 0) throw new Error(`--var expects key=value, got ${JSON.stringify(f)}.`);
    out[f.slice(0, i)] = f.slice(i + 1);
  }
  return out;
}
