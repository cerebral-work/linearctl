import { describe, expect, test } from "bun:test";
import type { LinearClient } from "@linear/sdk";
import { resolveTeamByKey } from "../src/core/teams.js";

function stubClient(teams: { id: string; key: string; name: string }[]): LinearClient {
  return {
    teams: () => Promise.resolve({ nodes: teams }),
  } as unknown as LinearClient;
}

describe("resolveTeamByKey", () => {
  test("resolves a team by its key", async () => {
    const client = stubClient([{ id: "t1", key: "CER", name: "Cerebral" }]);

    const team = await resolveTeamByKey(client, "CER");

    expect(team.id).toBe("t1");
    expect(team.key).toBe("CER");
    expect(team.name).toBe("Cerebral");
  });

  test("is case-insensitive (lowercase key)", async () => {
    const client = stubClient([{ id: "t1", key: "CER", name: "Cerebral" }]);

    const team = await resolveTeamByKey(client, "cer");

    expect(team.key).toBe("CER");
  });

  test("is case-insensitive (uppercase key, stub lowercases via filter)", async () => {
    const client = stubClient([{ id: "t2", key: "OPS", name: "Operations" }]);

    const team = await resolveTeamByKey(client, "ops");

    expect(team.key).toBe("OPS");
  });

  test("trims whitespace before resolving", async () => {
    const client = stubClient([{ id: "t1", key: "CER", name: "Cerebral" }]);

    const team = await resolveTeamByKey(client, "  CER  ");

    expect(team.key).toBe("CER");
  });

  test("throws with a helpful message when team key not found", async () => {
    const client = stubClient([]);

    await expect(resolveTeamByKey(client, "NOPE")).rejects.toThrow(
      /no team with key.*NOPE.*Settings.*Teams/,
    );
  });

  test("returns the first match when multiple exist (shouldn't happen, but stable)", async () => {
    const client = stubClient([
      { id: "t1", key: "CER", name: "Cerebral" },
      { id: "t2", key: "CER", name: "Duplicate" },
    ]);

    const team = await resolveTeamByKey(client, "CER");

    expect(team.id).toBe("t1");
  });
});
