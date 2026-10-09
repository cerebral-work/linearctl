import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import type { LinearClient } from "@linear/sdk";
import { relate } from "../src/commands/relate.js";
import { openCacheDb, type CacheDbInstance } from "../src/core/cache/db.js";
import * as schema from "../src/core/cache/schema.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function makeMockClient() {
  const relationCalls: Array<{ issueId: string; relatedIssueId: string; type: string }> = [];
  const rawRequestCalls: Array<{ query: string; vars: any }> = [];
  let duplicateRelationCreated = false;

  const mock = {
    issue: async (ref: string) => {
      return { id: `uuid-${ref.toLowerCase()}` };
    },
    createIssueRelation: async (input: { issueId: string; relatedIssueId: string; type: string }) => {
      relationCalls.push(input);
      return {
        success: true,
        issueRelation: Promise.resolve({ id: `rel-${relationCalls.length}` }),
      };
    },
    client: {
      rawRequest: async (query: string, vars: any) => {
        rawRequestCalls.push({ query, vars });
        if (query.includes("query DuplicateIssue")) {
          const canonical = ["CAN-1", "canonical", "uuid-can-1"].includes(vars.id);
          return {
            data: {
              issue: {
                id: canonical ? "uuid-can-1" : "uuid-src-1",
                identifier: canonical ? "CAN-1" : "SRC-1",
                title: "Duplicate Issue Title",
                url: "https://example.com/issue",
                team: { id: "team-1" },
                state: { id: "todo", name: "Todo", type: "unstarted" },
                assignee: null,
              },
            },
          };
        }
        if (query.includes("query DuplicateRelations")) {
          return {
            data: {
              issue: {
                relations: {
                  nodes: duplicateRelationCreated
                    ? [{ type: "duplicate", relatedIssue: { id: "uuid-can-1" } }]
                    : [],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            },
          };
        }
        if (query.includes("mutation DuplicateRelationCreate")) {
          duplicateRelationCreated = true;
          return { data: { issueRelationCreate: { success: true } } };
        }
        throw new Error(`unexpected query: ${query}`);
      },
    },
  } as unknown as LinearClient;

  return { client: mock, relationCalls, rawRequestCalls };
}

function captureStdout(fn: () => Promise<void>): Promise<string> {
  return new Promise(async (resolve, reject) => {
    let output = "";
    const originalWrite = process.stdout.write;
    process.stdout.write = ((chunk: any) => {
      output += String(chunk);
      return true;
    }) as any;
    try {
      await fn();
      resolve(output);
    } catch (err) {
      reject(err);
    } finally {
      process.stdout.write = originalWrite;
    }
  });
}

describe("linearctl relate command", () => {
  let tempDir: string;
  let tempDbPath: string;
  let origCacheFile: string | undefined;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "linearctl-relate-test-"));
    tempDbPath = join(tempDir, "cache.sqlite");
    origCacheFile = process.env.LINEARCTL_CACHE_FILE;
    process.env.LINEARCTL_CACHE_FILE = tempDbPath;
  });

  afterEach(() => {
    if (origCacheFile !== undefined) {
      process.env.LINEARCTL_CACHE_FILE = origCacheFile;
    } else {
      delete process.env.LINEARCTL_CACHE_FILE;
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe("Usage & validation", () => {
    test("throws usageError when id is empty or whitespace", async () => {
      const { client } = makeMockClient();
      expect(relate("", { blockedBy: ["CER-2"] }, client)).rejects.toThrow("issue ID or identifier is required.");
      expect(relate("   ", { blockedBy: ["CER-2"] }, client)).rejects.toThrow("issue ID or identifier is required.");
    });

    test("throws usageError when no relation flags are provided", async () => {
      const { client } = makeMockClient();
      expect(relate("CER-1", {}, client)).rejects.toThrow(
        "at least one relation flag (--blocked-by, --blocking, --related-to, --duplicate-of) is required.",
      );
    });
  });

  describe("Relation wiring logic", () => {
    test("--blocked-by creates blocks relation from blocker to target", async () => {
      const { client, relationCalls } = makeMockClient();
      const out = await captureStdout(() => relate("CER-10", { blockedBy: ["CER-20"] }, client));

      expect(relationCalls).toEqual([
        { issueId: "uuid-cer-20", relatedIssueId: "uuid-cer-10", type: "blocks" },
      ]);
      expect(out).toBe("CER-10: blocked-by CER-20\n");
    });

    test("--blocking creates blocks relation from target to blocked issue", async () => {
      const { client, relationCalls } = makeMockClient();
      const out = await captureStdout(() => relate("CER-10", { blocking: ["CER-30"] }, client));

      expect(relationCalls).toEqual([
        { issueId: "uuid-cer-10", relatedIssueId: "uuid-cer-30", type: "blocks" },
      ]);
      expect(out).toBe("CER-10: blocking CER-30\n");
    });

    test("--related-to creates related relation from target to other issue", async () => {
      const { client, relationCalls } = makeMockClient();
      const out = await captureStdout(() => relate("CER-10", { relatedTo: ["CER-40"] }, client));

      expect(relationCalls).toEqual([
        { issueId: "uuid-cer-10", relatedIssueId: "uuid-cer-40", type: "related" },
      ]);
      expect(out).toBe("CER-10: related-to CER-40\n");
    });

    test("supports multiple and comma-separated issue references", async () => {
      const { client, relationCalls } = makeMockClient();
      const out = await captureStdout(() =>
        relate(
          "CER-10",
          {
            blockedBy: ["CER-20, CER-21"],
            blocking: ["CER-30", "CER-31"],
            relatedTo: ["CER-40,CER-41"],
          },
          client,
        ),
      );

      expect(relationCalls).toEqual([
        { issueId: "uuid-cer-20", relatedIssueId: "uuid-cer-10", type: "blocks" },
        { issueId: "uuid-cer-21", relatedIssueId: "uuid-cer-10", type: "blocks" },
        { issueId: "uuid-cer-10", relatedIssueId: "uuid-cer-30", type: "blocks" },
        { issueId: "uuid-cer-10", relatedIssueId: "uuid-cer-31", type: "blocks" },
        { issueId: "uuid-cer-10", relatedIssueId: "uuid-cer-40", type: "related" },
        { issueId: "uuid-cer-10", relatedIssueId: "uuid-cer-41", type: "related" },
      ]);
      expect(out).toContain("blocked-by CER-20");
      expect(out).toContain("blocked-by CER-21");
      expect(out).toContain("blocking CER-30");
      expect(out).toContain("blocking CER-31");
      expect(out).toContain("related-to CER-40");
      expect(out).toContain("related-to CER-41");
    });

    test("--json produces structured JSON payload", async () => {
      const { client } = makeMockClient();
      const out = await captureStdout(() =>
        relate(
          "CER-10",
          {
            blockedBy: ["CER-20"],
            blocking: ["CER-30"],
            relatedTo: ["CER-40"],
            json: true,
          },
          client,
        ),
      );

      const parsed = JSON.parse(out);
      expect(parsed).toEqual({
        identifier: "CER-10",
        relations: {
          blockedBy: ["CER-20"],
          blocking: ["CER-30"],
          relatedTo: ["CER-40"],
        },
      });
    });

    test("--duplicate-of wires duplicate relation and formats output", async () => {
      const { client, rawRequestCalls } = makeMockClient();
      const out = await captureStdout(() =>
        relate("SRC-1", { duplicateOf: "CAN-1" }, client),
      );

      expect(rawRequestCalls.some((c) => c.query.includes("DuplicateRelationCreate"))).toBe(true);
      expect(out).toBe("SRC-1: duplicate-of CAN-1\n");
    });

    test("--duplicate-of with --json outputs duplicateOf record", async () => {
      const { client } = makeMockClient();
      const out = await captureStdout(() =>
        relate("SRC-1", { duplicateOf: "CAN-1", json: true }, client),
      );

      const parsed = JSON.parse(out);
      expect(parsed).toEqual({
        identifier: "SRC-1",
        duplicateOf: {
          id: "uuid-can-1",
          identifier: "CAN-1",
        },
      });
    });
  });

  describe("Cache Write-Through", () => {
    test("populates local SQLite issue_relations table when cache db exists", async () => {
      const cache = openCacheDb({ dbPath: tempDbPath });
      try {
        // Pre-seed issues in local cache to test identifier -> UUID resolution
        cache.db
          .insert(schema.issues)
          .values([
            {
              id: "uuid-cer-10",
              identifier: "CER-10",
              number: 10,
              title: "Issue 10",
              teamKey: "CER",
              stateName: "Todo",
              stateType: "unstarted",
              url: "https://linear.app/cerebral/issue/CER-10",
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            },
            {
              id: "uuid-cer-20",
              identifier: "CER-20",
              number: 20,
              title: "Issue 20",
              teamKey: "CER",
              stateName: "Todo",
              stateType: "unstarted",
              url: "https://linear.app/cerebral/issue/CER-20",
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            },
            {
              id: "uuid-cer-30",
              identifier: "CER-30",
              number: 30,
              title: "Issue 30",
              teamKey: "CER",
              stateName: "Todo",
              stateType: "unstarted",
              url: "https://linear.app/cerebral/issue/CER-30",
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            },
          ])
          .run();

        const { client } = makeMockClient();
        await captureStdout(() =>
          relate(
            "CER-10",
            {
              blockedBy: ["CER-20"],
              blocking: ["CER-30"],
            },
            client,
          ),
        );

        // Verify entries in SQLite cache
        const rows = cache.db.select().from(schema.issueRelations).all();
        expect(rows.length).toBe(2);

        // Blocker relation: CER-20 blocks CER-10
        const blockedByRel = rows.find(
          (r) => r.issueId === "uuid-cer-20" && r.relatedIssueId === "uuid-cer-10",
        );
        expect(blockedByRel).toBeDefined();
        expect(blockedByRel?.type).toBe("blocks");

        // Blocking relation: CER-10 blocks CER-30
        const blockingRel = rows.find(
          (r) => r.issueId === "uuid-cer-10" && r.relatedIssueId === "uuid-cer-30",
        );
        expect(blockingRel).toBeDefined();
        expect(blockingRel?.type).toBe("blocks");
      } finally {
        cache.close();
      }
    });
  });

  describe("Subprocess CLI integration", () => {
    async function runCli(args: string[]) {
      const proc = Bun.spawn(
        [process.execPath, "src/index.ts", ...args],
        {
          cwd: join(import.meta.dir, ".."),
          env: {
            ...process.env,
            LINEAR_API_KEY: "test-api-key",
            NO_COLOR: "1",
          },
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [code, out, err] = await Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      return { code, out, err };
    }

    test("relate without id exits 2 with usage error", async () => {
      const res = await runCli(["relate", "--json"]);
      expect(res.code).toBe(2);
      const err = JSON.parse(res.err);
      expect(err.error.kind).toBe("usage");
      expect(err.error.message).toContain("relate needs an <id>");
    });

    test("relate without relation flags exits 2 with usage error", async () => {
      const res = await runCli(["relate", "CER-10", "--json"]);
      expect(res.code).toBe(2);
      const err = JSON.parse(res.err);
      expect(err.error.kind).toBe("usage");
      expect(err.error.message).toContain("at least one relation flag");
    });
  });
});
