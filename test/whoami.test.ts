import { describe, expect, test } from "bun:test";
import type { LinearClient } from "@linear/sdk";
import { getWhoami } from "../src/core/whoami.js";

function stubClient(opts: {
  viewer?: { id: string; name: string; displayName: string; email: string; admin: boolean };
  org?: { id: string; name: string; urlKey: string };
}): LinearClient {
  return {
    viewer: Promise.resolve(opts.viewer ?? {
      id: "user-1",
      name: "Christian Todie",
      displayName: "ctodie",
      email: "chris@todie.io",
      admin: true,
    }),
    organization: Promise.resolve(opts.org ?? {
      id: "org-1",
      name: "Cerebral Work",
      urlKey: "CLW",
    }),
  } as unknown as LinearClient;
}

describe("getWhoami", () => {
  test("resolves viewer + organization into flat record", async () => {
    const client = stubClient({});

    const result = await getWhoami(client);

    expect(result.id).toBe("user-1");
    expect(result.name).toBe("Christian Todie");
    expect(result.displayName).toBe("ctodie");
    expect(result.email).toBe("chris@todie.io");
    expect(result.admin).toBe(true);
  });

  test("includes organization id, name, urlKey", async () => {
    const client = stubClient({
      org: { id: "org-42", name: "Test Org", urlKey: "TST" },
    });

    const result = await getWhoami(client);

    expect(result.organization.id).toBe("org-42");
    expect(result.organization.name).toBe("Test Org");
    expect(result.organization.urlKey).toBe("TST");
  });

  test("non-admin viewer → admin=false", async () => {
    const client = stubClient({
      viewer: {
        id: "user-2",
        name: "Guest",
        displayName: "guest",
        email: "guest@example.com",
        admin: false,
      },
    });

    const result = await getWhoami(client);

    expect(result.admin).toBe(false);
  });
});
