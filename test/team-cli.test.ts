import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { openCacheDb, type CacheDbInstance } from "../src/core/cache/db.js";
import { teams } from "../src/core/cache/schema.js";
import { getCachedTeams, getCachedTeam } from "../src/core/cache/query.js";
import { teamList, teamResolve } from "../src/commands/team.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("Cached Team Query & CLI Handlers", () => {
  let cache: CacheDbInstance;
  let tempDir: string;
  let tempDbPath: string;
  let originalEnvCacheFile: string | undefined;

  const sampleTeams = [
    {
      id: "uuid-ops-1",
      key: "OPS",
      name: "Operations",
      displayName: "DevOps",
      description: "Infra and platform ops",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
    {
      id: "uuid-cer-1",
      key: "CER",
      name: "Cerebral",
      displayName: "Cerebral Core",
      description: "Core agents and workspace",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
  ];

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "linearctl-team-test-"));
    tempDbPath = join(tempDir, "cache.sqlite");
    originalEnvCacheFile = process.env.LINEARCTL_CACHE_FILE;
    process.env.LINEARCTL_CACHE_FILE = tempDbPath;

    cache = openCacheDb({ dbPath: tempDbPath });
    for (const t of sampleTeams) {
      cache.db.insert(teams).values(t).run();
    }
  });

  afterEach(() => {
    cache.close();
    if (originalEnvCacheFile !== undefined) {
      process.env.LINEARCTL_CACHE_FILE = originalEnvCacheFile;
    } else {
      delete process.env.LINEARCTL_CACHE_FILE;
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe("getCachedTeams", () => {
    test("returns all teams ordered by key ascending", () => {
      const results = getCachedTeams(cache);
      expect(results.length).toBe(2);
      expect(results[0].key).toBe("CER");
      expect(results[1].key).toBe("OPS");
      expect(results[0].name).toBe("Cerebral");
      expect(results[1].name).toBe("Operations");
    });
  });

  describe("getCachedTeam", () => {
    test("resolves by exact UUID", () => {
      const team = getCachedTeam(cache, "uuid-cer-1");
      expect(team).not.toBeNull();
      expect(team?.key).toBe("CER");
    });

    test("resolves by exact key", () => {
      const team = getCachedTeam(cache, "CER");
      expect(team).not.toBeNull();
      expect(team?.name).toBe("Cerebral");
    });

    test("resolves by case-insensitive key", () => {
      const team = getCachedTeam(cache, "cer");
      expect(team).not.toBeNull();
      expect(team?.key).toBe("CER");
    });

    test("resolves by exact name", () => {
      const team = getCachedTeam(cache, "Operations");
      expect(team).not.toBeNull();
      expect(team?.key).toBe("OPS");
    });

    test("resolves by case-insensitive name", () => {
      const team = getCachedTeam(cache, "operations");
      expect(team).not.toBeNull();
      expect(team?.key).toBe("OPS");
    });

    test("resolves by substring / like match", () => {
      const team = getCachedTeam(cache, "cereb");
      expect(team).not.toBeNull();
      expect(team?.key).toBe("CER");
    });

    test("returns null/undefined for unknown team", () => {
      const team = getCachedTeam(cache, "NONEXISTENT");
      expect(team).toBeFalsy();
    });
  });

  describe("teamList command handler with --cache", () => {
    test("emits formatted json when opts.json is true", async () => {
      const chunks: string[] = [];
      const originalWrite = process.stdout.write;
      process.stdout.write = (chunk: string | Uint8Array) => {
        chunks.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
        return true;
      };

      try {
        await teamList({ cache: true, json: true });
      } finally {
        process.stdout.write = originalWrite;
      }

      const output = chunks.join("");
      const parsed = JSON.parse(output);
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed.length).toBe(2);
      expect(parsed[0].key).toBe("CER");
      expect(parsed[1].key).toBe("OPS");
    });

    test("renders plain table when opts.json is false", async () => {
      const chunks: string[] = [];
      const originalWrite = process.stdout.write;
      process.stdout.write = (chunk: string | Uint8Array) => {
        chunks.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
        return true;
      };

      try {
        await teamList({ cache: true, json: false });
      } finally {
        process.stdout.write = originalWrite;
      }

      const output = chunks.join("");
      expect(output).toContain("CER");
      expect(output).toContain("Cerebral");
      expect(output).toContain("OPS");
      expect(output).toContain("Operations");
    });
  });

  describe("teamResolve command handler with --cache", () => {
    test("resolves team and emits json", async () => {
      const chunks: string[] = [];
      const originalWrite = process.stdout.write;
      process.stdout.write = (chunk: string | Uint8Array) => {
        chunks.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
        return true;
      };

      try {
        await teamResolve("cer", { cache: true, json: true });
      } finally {
        process.stdout.write = originalWrite;
      }

      const output = chunks.join("");
      const parsed = JSON.parse(output);
      expect(parsed.key).toBe("CER");
      expect(parsed.name).toBe("Cerebral");
      expect(parsed.id).toBe("uuid-cer-1");
    });

    test("resolves team and renders text", async () => {
      const chunks: string[] = [];
      const originalWrite = process.stdout.write;
      process.stdout.write = (chunk: string | Uint8Array) => {
        chunks.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
        return true;
      };

      try {
        await teamResolve("Operations", { cache: true, json: false });
      } finally {
        process.stdout.write = originalWrite;
      }

      const output = chunks.join("");
      expect(output).toContain("team Operations (OPS)");
      expect(output).toContain("id:          uuid-ops-1");
      expect(output).toContain("description: Infra and platform ops");
    });

    test("throws usageError when ref is missing or empty", async () => {
      await expect(teamResolve("", { cache: true })).rejects.toThrow(
        /team resolve requires a team key, name, or id/,
      );
      await expect(teamResolve("   ", { cache: true })).rejects.toThrow(
        /team resolve requires a team key, name, or id/,
      );
    });

    test("throws notFoundError when ref cannot be resolved in cache", async () => {
      await expect(teamResolve("NONEXISTENT", { cache: true })).rejects.toThrow(
        /team matching "NONEXISTENT" not found in local cache/,
      );
    });
  });
});
