import { describe, expect, test } from "bun:test";
import type { LinearClient } from "@linear/sdk";
import { resolveTeamByKey, listTeams, resolveTeam } from "../src/core/teams.js";

function stubClient(
  teams: { id: string; key: string; name: string; displayName?: string | null; description?: string | null }[],
): LinearClient {
  return {
    teams: (args?: { filter?: { key?: { eqIgnoreCase?: string } }; first?: number }) => {
      let filtered = teams;
      if (args?.filter?.key?.eqIgnoreCase) {
        const k = args.filter.key.eqIgnoreCase.toLowerCase();
        filtered = teams.filter((t) => t.key.toLowerCase() === k);
      }
      return Promise.resolve({ nodes: filtered });
    },
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

describe("listTeams", () => {
  test("returns empty array when no teams are accessible", async () => {
    const client = stubClient([]);
    const teams = await listTeams(client);
    expect(teams).toEqual([]);
  });

  test("returns teams sorted by key ascending with summary fields", async () => {
    const client = stubClient([
      { id: "t2", key: "OPS", name: "Operations", displayName: "Ops Core", description: "Infra team" },
      { id: "t1", key: "CER", name: "Cerebral", displayName: null, description: null },
    ]);

    const teams = await listTeams(client);

    expect(teams).toEqual([
      { id: "t1", key: "CER", name: "Cerebral", displayName: null, description: null },
      { id: "t2", key: "OPS", name: "Operations", displayName: "Ops Core", description: "Infra team" },
    ]);
  });
});

describe("resolveTeam", () => {
  const sampleTeams = [
    { id: "uuid-cer-1234", key: "CER", name: "Cerebral", displayName: "Cerebral Platform", description: "Core" },
    { id: "uuid-ops-5678", key: "OPS", name: "Operations", displayName: "DevOps", description: "Infra" },
  ];

  test("resolves by exact key", async () => {
    const client = stubClient(sampleTeams);
    const team = await resolveTeam(client, "CER");
    expect(team.id).toBe("uuid-cer-1234");
    expect(team.key).toBe("CER");
  });

  test("resolves by lowercase key", async () => {
    const client = stubClient(sampleTeams);
    const team = await resolveTeam(client, "ops");
    expect(team.id).toBe("uuid-ops-5678");
    expect(team.key).toBe("OPS");
  });

  test("resolves by team name (case-insensitive)", async () => {
    const client = stubClient(sampleTeams);
    const team = await resolveTeam(client, "cerebral");
    expect(team.id).toBe("uuid-cer-1234");
    expect(team.name).toBe("Cerebral");
  });

  test("resolves by displayName (case-insensitive)", async () => {
    const client = stubClient(sampleTeams);
    const team = await resolveTeam(client, "devops");
    expect(team.id).toBe("uuid-ops-5678");
  });

  test("resolves by UUID", async () => {
    const client = stubClient(sampleTeams);
    const team = await resolveTeam(client, "uuid-cer-1234");
    expect(team.key).toBe("CER");
  });

  test("throws notFoundError with available keys when team not found", async () => {
    const client = stubClient(sampleTeams);
    await expect(resolveTeam(client, "UNKNOWN")).rejects.toThrow(
      /no team matching "UNKNOWN" — available team keys: CER, OPS/,
    );
  });
});
