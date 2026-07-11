import { makeClient } from "../client.js";
import { createIssue } from "../core/issues.js";
import { listTemplates, loadTemplate } from "../core/templates.js";
import { renderTemplate, templateVars, parseVarFlags } from "../lib/template.js";
import { readStdin } from "../lib/io.js";
import { printJson, printTable } from "../lib/output.js";
import { withSpinner } from "../lib/spinner.js";

/** `linearctl template list` — see docs/features/template.md (CER-1562). */
export async function templateList(opts: { json?: boolean }): Promise<void> {
  const entries = listTemplates();
  if (opts.json) {
    printJson(entries);
    return;
  }
  if (!entries.length) {
    process.stdout.write("no templates — add .linearctl/templates/<name>.md\n");
    return;
  }
  printTable(
    entries.map((e) => ({ name: e.name, source: e.source, path: e.path })),
    ["name", "source", "path"],
  );
}

/** `linearctl template validate <name>` — parse + report variables. */
export async function templateValidate(name: string, opts: { json?: boolean }): Promise<void> {
  const t = loadTemplate(name);
  const vars = templateVars(t);
  const required = vars.filter((v) => v.default === undefined).map((v) => v.name);
  const optional = vars.filter((v) => v.default !== undefined).map((v) => v.name);
  if (opts.json) {
    printJson({ name: t.name, title: t.title, labels: t.labels, required, optional });
    return;
  }
  process.stdout.write(
    `${t.name}: OK\n  title: ${t.title}\n  labels: ${t.labels.join(", ") || "—"}\n` +
      `  required vars: ${required.join(", ") || "—"}\n  optional vars: ${optional.join(", ") || "—"}\n`,
  );
}

export interface TemplateFileOptions {
  team?: string;
  project?: string;
  var?: string[];
  json?: boolean;
}

/** `linearctl template file <name> --team KEY --var key=value...` */
export async function templateFile(name: string, opts: TemplateFileOptions): Promise<void> {
  if (!opts.team) throw new Error("template file needs --team <key>.");
  const t = loadTemplate(name);
  const vars = parseVarFlags(opts.var ?? []);
  for (const [k, v] of Object.entries(vars)) {
    if (v === "-") vars[k] = (await readStdin()).trim();
  }
  const { title, description } = renderTemplate(t, vars);

  const client = makeClient();
  const issue = await withSpinner("Filing from template…", () =>
    createIssue(client, {
      teamKey: opts.team as string,
      title,
      description,
      projectId: opts.project,
      labels: t.labels.length ? t.labels : undefined,
    }),
  );

  if (opts.json) {
    printJson({ ...issue, template: t.name });
    return;
  }
  process.stdout.write(
    `filed ${issue.identifier} from "${t.name}": ${issue.title}\n  url: ${issue.url}\n`,
  );
}
