import { describe, expect, test } from "bun:test";
import type { LinearClient } from "@linear/sdk";
import { initiatives, rollupInitiative } from "../src/core/initiatives.js";
import { renderInitiatives } from "../src/commands/initiative.js";

function initNode(
  name: string,
  status: string,
  projects: { name: string; state: string; progress: number }[],
) {
  return {
    id: name,
    name,
    status,
    targetDate: null,
    url: "u",
    projects: {
      nodes: projects.map((p) => ({ ...p, targetDate: null, url: "u" })),
    },
  };
}

function stubClient(nodes: ReturnType<typeof initNode>[]) {
  return {
    client: {
      rawRequest: async () => ({
        data: {
          initiatives: { nodes, pageInfo: { hasNextPage: false, endCursor: null } },
        },
      }),
    },
  } as unknown as LinearClient;
}

describe("initiative — rollup", () => {
  test("mean progress across projects", () => {
    const rollup = rollupInitiative(
      initNode("Ship v1", "Active", [
        { name: "A", state: "started", progress: 0.5 },
        { name: "B", state: "completed", progress: 1.0 },
      ]),
    );
    expect(rollup.progress).toBeCloseTo(0.75);
    expect(rollup.projects).toHaveLength(2);
  });

  test("no projects -> null progress", () => {
    expect(rollupInitiative(initNode("Empty", "Planned", [])).progress).toBeNull();
  });

  test("completed initiatives excluded by default, included with all", async () => {
    const nodes = [
      initNode("Live", "Active", []),
      initNode("Shipped", "Completed", []),
    ];
    expect((await initiatives(stubClient(nodes))).map((i) => i.name)).toEqual(["Live"]);
    expect((await initiatives(stubClient(nodes), true)).map((i) => i.name)).toEqual([
      "Live",
      "Shipped",
    ]);
  });
});

describe("initiative — render", () => {
  test("renders rollup lines with percentages", () => {
    const text = renderInitiatives([
      rollupInitiative(
        initNode("Ship v1", "Active", [{ name: "A", state: "started", progress: 0.5 }]),
      ),
    ]);
    expect(text).toContain("Ship v1 [Active] · 50% · 1 project(s)");
    expect(text).toContain("50%  A (started)");
  });

  test("empty state", () => {
    expect(renderInitiatives([])).toBe("No initiatives.\n");
  });
});
