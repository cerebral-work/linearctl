import { makeClient } from "../client.js";
import { attachLink } from "../core/issues.js";
import { printJson } from "../lib/output.js";
import { withSpinner } from "../lib/spinner.js";

export interface LinkOptions {
  title?: string;
  json?: boolean;
}

/**
 * `linearctl link <id> <url> [--title]` — attach a URL to an issue (the
 * PR-to-ticket case that previously needed a raw SDK createAttachment).
 * CER-1192 item 3.
 */
export async function linkCmd(id: string, url: string, opts: LinkOptions): Promise<void> {
  const client = makeClient();
  const result = await withSpinner(`Attaching to ${id}…`, () =>
    attachLink(client, id, url, opts.title),
  );
  if (opts.json) {
    printJson(result);
    return;
  }
  process.stdout.write(`attached ${url} to ${result.identifier}\n`);
}
