import { makeClient } from "../client.js";
import { printJson } from "../lib/output.js";

export interface WhoamiOptions {
  json?: boolean;
}

/**
 * `linearctl whoami` — resolve the authenticated viewer.
 *
 * The thin vertical slice that proves the auth path end-to-end: a single
 * read-only `viewer` (+ `organization`) query. Run this first on any new
 * machine to confirm `LINEAR_API_KEY` is wired before reaching for the heavier
 * commands.
 */
export async function whoami(opts: WhoamiOptions): Promise<void> {
  const client = makeClient();
  const me = await client.viewer;
  const org = await client.organization;

  if (opts.json) {
    printJson({
      id: me.id,
      name: me.name,
      displayName: me.displayName,
      email: me.email,
      admin: me.admin,
      organization: { id: org.id, name: org.name, urlKey: org.urlKey },
    });
    return;
  }

  process.stdout.write(
    `${me.name} <${me.email}>${me.admin ? " (admin)" : ""}\n` +
      `  org:     ${org.name} (${org.urlKey})\n` +
      `  user id: ${me.id}\n`,
  );
}
