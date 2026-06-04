import type { LinearClient } from "@linear/sdk";

export interface WhoamiResult {
  id: string;
  name: string;
  displayName: string;
  email: string;
  admin: boolean;
  organization: { id: string; name: string; urlKey: string };
}

/**
 * Resolve the authenticated viewer + organization.
 *
 * The thin read that proves the auth path end-to-end. Pure domain logic: takes a
 * client, returns data, never touches commander / stdout / process.exit.
 */
export async function getWhoami(client: LinearClient): Promise<WhoamiResult> {
  const me = await client.viewer;
  const org = await client.organization;
  return {
    id: me.id,
    name: me.name,
    displayName: me.displayName,
    email: me.email,
    admin: me.admin,
    organization: { id: org.id, name: org.name, urlKey: org.urlKey },
  };
}
