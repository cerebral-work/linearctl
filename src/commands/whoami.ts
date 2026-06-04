import { makeClient } from "../client.js";
import { getWhoami } from "../core/whoami.js";
import { printJson } from "../lib/output.js";

export interface WhoamiOptions {
  json?: boolean;
}

/**
 * `linearctl whoami` — resolve the authenticated viewer.
 *
 * The thin vertical slice that proves the auth path end-to-end. Delegates to
 * `core.getWhoami`; this layer only parses flags and formats output.
 */
export async function whoami(opts: WhoamiOptions): Promise<void> {
  const client = makeClient();
  const me = await getWhoami(client);

  if (opts.json) {
    printJson(me);
    return;
  }

  process.stdout.write(
    `${me.name} <${me.email}>${me.admin ? " (admin)" : ""}\n` +
      `  org:     ${me.organization.name} (${me.organization.urlKey})\n` +
      `  user id: ${me.id}\n`,
  );
}
