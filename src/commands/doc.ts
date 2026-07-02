import { readFile } from "node:fs/promises";
import { makeClient } from "../client.js";
import { getProjectOverview, setProjectOverview } from "../core/projects.js";
import { readStdin } from "../lib/io.js";
import { printJson } from "../lib/output.js";

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
    opts.file === "-" ? await readStdin() : await readFile(opts.file, "utf8");

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
