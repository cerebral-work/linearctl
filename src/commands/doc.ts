import { readFile } from "node:fs/promises";
import { makeClient } from "../client.js";
import { getProjectOverview, setProjectOverview } from "../core/projects.js";
import { readStdinFor } from "../lib/io.js";
import { printJson, printTable } from "../lib/output.js";
import { listDocuments, createDocument, updateDocument } from "../core/documents.js";

export interface DocGetOverviewOptions {
  project: string;
  json?: boolean;
}

/**
 * `linearctl doc get-overview --project <ref>` — print a project's overview
 * document (markdown). Human output is the raw markdown (pipe it to a file);
 * `--json` wraps it with the project identity. See docs/spec.md §6.13.
 */
export async function docGetOverview(opts: DocGetOverviewOptions): Promise<void> {
  const client = makeClient();
  const overview = await getProjectOverview(client, opts.project);

  if (opts.json) {
    printJson(overview);
    return;
  }

  if (overview.content === null) {
    console.error(
      `(project ${overview.project.name} has no overview document)`,
    );
    return;
  }
  process.stdout.write(overview.content + "\n");
}

export interface DocSetOverviewOptions {
  project: string;
  file: string;
  json?: boolean;
}

/**
 * `linearctl doc set-overview --project <ref> --file <md>` — replace a
 * project's overview document with a markdown file ('-' reads stdin).
 * Whole-document replace; refuses empty content. See docs/spec.md §6.13.
 */
export async function docSetOverview(opts: DocSetOverviewOptions): Promise<void> {
  const client = makeClient();
  const content =
    opts.file === "-" ? await readStdinFor("--file -") : await readFile(opts.file, "utf8");

  const overview = await setProjectOverview(client, opts.project, content);

  if (opts.json) {
    printJson(overview);
    return;
  }

  process.stdout.write(
    `overview updated on ${overview.project.name}\n` +
      `  url:   ${overview.project.url}\n` +
      `  id:    ${overview.project.id}\n` +
      `  bytes: ${Buffer.byteLength(overview.content ?? "", "utf8")}\n`,
  );
}

export interface DocListOptions {
  project?: string;
  json?: boolean;
}

/** `linearctl doc list [--project REF]` — see CER-1344. */
export async function docList(opts: DocListOptions): Promise<void> {
  const client = makeClient();
  const docs = await listDocuments(client, { project: opts.project });
  if (opts.json) {
    printJson(docs);
    return;
  }
  printTable(
    docs.map((d) => ({ slug: d.slugId, project: d.project ?? "—", title: d.title })),
    ["slug", "project", "title"],
  );
}

export interface DocCreateOptions {
  project?: string;
  issue?: string;
  team?: string;
  content?: string;
  json?: boolean;
}

/** `linearctl doc create <title> --project|--issue|--team --content <md|->`. */
export async function docCreate(title: string, opts: DocCreateOptions): Promise<void> {
  if (!opts.content) throw new Error("doc create needs --content <md> ('-' reads stdin).");
  const client = makeClient();
  const content = opts.content === "-" ? await readStdinFor("--content -") : opts.content;
  const doc = await createDocument(client, {
    title,
    content,
    project: opts.project,
    issue: opts.issue,
    teamKey: opts.team,
  });
  if (opts.json) {
    printJson(doc);
    return;
  }
  process.stdout.write(`created doc "${doc.title}" (${doc.slugId})\n  url: ${doc.url}\n`);
}

export interface DocUpdateOptions {
  content?: string;
  title?: string;
  json?: boolean;
}

/** `linearctl doc update <id|slug> [--content <md|->] [--title]`. */
export async function docUpdate(ref: string, opts: DocUpdateOptions): Promise<void> {
  const client = makeClient();
  const content = opts.content === "-" ? await readStdinFor("--content -") : opts.content;
  const doc = await updateDocument(client, ref, { content, title: opts.title });
  if (opts.json) {
    printJson(doc);
    return;
  }
  process.stdout.write(`updated doc "${doc.title}" (${doc.slugId})\n  url: ${doc.url}\n`);
}
