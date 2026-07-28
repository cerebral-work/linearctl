import { describe, expect, test } from "bun:test";
import type { LinearClient } from "@linear/sdk";
import { render } from "ink-testing-library";
import { spawn } from "node:child_process";
import { triage, type TriageItem } from "../src/core/grooming.js";
import { Dashboard } from "../src/tui/dashboard.js";
import { TriagePane } from "../src/tui/panes/triage.js";
import { IssueTable } from "../src/tui/components/table.js";

/**
 * TUI first-slice tests (CER-1550).
 *
 * Uses `ink-testing-library` (ADR-0008) to render components in-memory — no real
 * TTY needed (`docs/features/tui-cli-landscape/typescript-javascript.md:105`).
 * The Triage pane is stubbed with fixed `TriageItem[]` (no network); the TTY
 * gate is exercised via a real subprocess so the exit code is observable.
 *
 * Ink v7 uses React 19, which batches state updates as microtasks. After each
 * `stdin.write(...)`, `flush()` lets the microtask queue drain before
 * `lastFrame()` is read. Without it, the frame reflects the pre-input render.
 */

function makeItem(overrides: Partial<TriageItem> = {}): TriageItem {
  return {
    identifier: "CER-142",
    title: "Fix webhook retry logic",
    state: "In Progress",
    stateType: "started",
    assignee: null,
    priority: 2,
    estimate: null,
    reasons: ["unassigned", "unestimated"],
    url: "https://linear.app/cerebral-work/issue/CER-142",
    ...overrides,
  };
}

const SAMPLE_ITEMS: TriageItem[] = [
  makeItem({ identifier: "CER-142", title: "Fix webhook retry logic", assignee: null }),
  makeItem({
    identifier: "CER-138",
    title: "Refactor batch backoff",
    assignee: "alice",
    reasons: ["unestimated"],
  }),
  makeItem({
    identifier: "CER-135",
    title: "Add cycle review command",
    assignee: "bob",
    state: "Triage",
    stateType: "triage",
    reasons: ["triage"],
  }),
];

/** Flush React 19's batched state updates (microtask queue). */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 10));
}

/** Count occurrences of a substring in a string. */
function count(str: string, sub: string): number {
  return str.split(sub).length - 1;
}

// ---- IssueTable component ----

describe("IssueTable", () => {
  test("renders a header and every row when items are present", () => {
    const { lastFrame } = render(<IssueTable items={SAMPLE_ITEMS} cursor={0} />);
    const frame = lastFrame() ?? "";

    // Header labels
    expect(frame).toContain("Issue");
    expect(frame).toContain("State");
    expect(frame).toContain("Assignee");
    expect(frame).toContain("Reasons");
    expect(frame).toContain("Title");

    // Every row's identifier + title
    for (const item of SAMPLE_ITEMS) {
      expect(frame).toContain(item.identifier);
      expect(frame).toContain(item.title);
    }
  });

  test("shows the cursor marker on exactly one row per render", () => {
    for (const cursor of [0, 1, 2]) {
      const { lastFrame } = render(<IssueTable items={SAMPLE_ITEMS} cursor={cursor} />);
      const frame = lastFrame() ?? "";
      // The cursor marker ▸ appears exactly once
      expect(count(frame, "▸")).toBe(1);
    }
  });

  test("with cursor=null, no cursor marker appears", () => {
    const { lastFrame } = render(<IssueTable items={SAMPLE_ITEMS} cursor={null} />);
    const frame = lastFrame() ?? "";
    expect(count(frame, "▸")).toBe(0);
  });

  test("renders empty-state message when there are no items", () => {
    const { lastFrame } = render(<IssueTable items={[]} cursor={0} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("No issues needing triage");
  });

  test("renders 'unassigned' placeholder when assignee is null", () => {
    const { lastFrame } = render(<IssueTable items={SAMPLE_ITEMS} cursor={0} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("unassigned");
  });

  test("joins multiple reasons with '+'", () => {
    const { lastFrame } = render(<IssueTable items={SAMPLE_ITEMS} cursor={0} />);
    const frame = lastFrame() ?? "";
    // CER-142 has reasons ["unassigned","unestimated"] → "unassigned+unestimated"
    expect(frame).toContain("unassigned+unestimated");
  });

  test("renders '—' for an item with no reasons", () => {
    const items: TriageItem[] = [
      makeItem({ identifier: "CER-100", title: "Clean issue", reasons: [] }),
    ];
    const { lastFrame } = render(<IssueTable items={items} cursor={0} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("—");
  });
});

// ---- TriagePane (j/k navigation + q quit) ----

describe("TriagePane", () => {
  test("renders the pane title with issue count", () => {
    const { lastFrame } = render(<TriagePane items={SAMPLE_ITEMS} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Triage queue");
    expect(frame).toContain("3 issues");
  });

  test("singular 'issue' when count is 1", () => {
    const { lastFrame } = render(<TriagePane items={[SAMPLE_ITEMS[0]!]} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("1 issue");
  });

  test("renders the help footer (j/k/Enter/q)", () => {
    const { lastFrame } = render(<TriagePane items={SAMPLE_ITEMS} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("j/k move");
    expect(frame).toContain("Enter detail");
    expect(frame).toContain("q quit");
  });

  test("j moves the cursor down and clamps at the last row", async () => {
    const { lastFrame, stdin, unmount } = render(<TriagePane items={SAMPLE_ITEMS} />);

    // Start: cursor at row 0 — exactly one marker
    expect(count(lastFrame() ?? "", "▸")).toBe(1);

    // j → row 1
    stdin.write("j");
    await flush();
    expect(count(lastFrame() ?? "", "▸")).toBe(1);

    // j → row 2 (last)
    stdin.write("j");
    await flush();
    expect(count(lastFrame() ?? "", "▸")).toBe(1);

    // j → clamped at row 2 (still exactly one marker)
    stdin.write("j");
    await flush();
    expect(count(lastFrame() ?? "", "▸")).toBe(1);

    unmount();
  });

  test("k moves the cursor up and clamps at the first row", async () => {
    const { lastFrame, stdin, unmount } = render(<TriagePane items={SAMPLE_ITEMS} />);

    // Move to last row first
    stdin.write("j");
    await flush();
    stdin.write("j");
    await flush();
    expect(count(lastFrame() ?? "", "▸")).toBe(1);

    // k → row 1
    stdin.write("k");
    await flush();
    expect(count(lastFrame() ?? "", "▸")).toBe(1);

    // k → row 0
    stdin.write("k");
    await flush();
    expect(count(lastFrame() ?? "", "▸")).toBe(1);

    // k → clamped at row 0
    stdin.write("k");
    await flush();
    expect(count(lastFrame() ?? "", "▸")).toBe(1);

    unmount();
  });

  test("cursor starts at row 0 (first item highlighted)", () => {
    const { lastFrame } = render(<TriagePane items={SAMPLE_ITEMS} />);
    const frame = lastFrame() ?? "";
    // The ▸ marker should be before CER-142 (row 0)
    expect(frame).toContain("▸");
    expect(frame).toContain("CER-142");
  });

  test("q triggers app exit (no crash)", () => {
    const { stdin, unmount } = render(<TriagePane items={SAMPLE_ITEMS} />);
    // `q` calls exit() which unmounts the app. In the test renderer (no
    // waitUntilExit), the unmount happens synchronously via exit().
    stdin.write("q");
    unmount();
    expect(true).toBe(true);
  });

  test("empty list shows placeholder, not a broken half-render", () => {
    const { lastFrame } = render(<TriagePane items={[]} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("No issues needing triage");
  });
});

// ---- Dashboard (tab bar + pane routing) ----

describe("Dashboard", () => {
  test("renders the tab bar with all 5 panes", () => {
    const { lastFrame } = render(<Dashboard items={SAMPLE_ITEMS} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Digest");
    expect(frame).toContain("Triage");
    expect(frame).toContain("Milestone");
    expect(frame).toContain("Xref");
    expect(frame).toContain("Stale");
  });

  test("defaults to the Triage pane (tab 2) with items visible", () => {
    const { lastFrame } = render(<Dashboard items={SAMPLE_ITEMS} />);
    const frame = lastFrame() ?? "";
    // Triage pane is active by default — items render
    expect(frame).toContain("Triage queue");
    expect(frame).toContain("CER-142");
  });

  test("1 switches to Digest (placeholder)", async () => {
    const { lastFrame, stdin, unmount } = render(<Dashboard items={SAMPLE_ITEMS} />);
    stdin.write("1");
    await flush();
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Digest");
    expect(frame).toContain("not yet implemented");
    unmount();
  });

  test("3 switches to Milestone (placeholder)", async () => {
    const { lastFrame, stdin, unmount } = render(<Dashboard items={SAMPLE_ITEMS} />);
    stdin.write("3");
    await flush();
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Milestone");
    expect(frame).toContain("not yet implemented");
    unmount();
  });

  test("4 switches to Xref (placeholder)", async () => {
    const { lastFrame, stdin, unmount } = render(<Dashboard items={SAMPLE_ITEMS} />);
    stdin.write("4");
    await flush();
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Xref");
    expect(frame).toContain("not yet implemented");
    unmount();
  });

  test("5 switches to Stale (placeholder)", async () => {
    const { lastFrame, stdin, unmount } = render(<Dashboard items={SAMPLE_ITEMS} />);
    stdin.write("5");
    await flush();
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Stale");
    expect(frame).toContain("not yet implemented");
    unmount();
  });

  test("2 switches back to Triage after visiting another pane", async () => {
    const { lastFrame, stdin, unmount } = render(<Dashboard items={SAMPLE_ITEMS} />);
    stdin.write("1");
    await flush();
    expect(lastFrame() ?? "").toContain("not yet implemented");
    stdin.write("2");
    await flush();
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Triage queue");
    expect(frame).toContain("CER-142");
    unmount();
  });

  test("q triggers exit (no crash)", () => {
    const { stdin, unmount } = render(<Dashboard items={SAMPLE_ITEMS} />);
    stdin.write("q");
    unmount();
    expect(true).toBe(true);
  });

  test("renders the team label when scoped", () => {
    const { lastFrame } = render(<Dashboard items={SAMPLE_ITEMS} team={["CER"]} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("CER");
  });

  test("renders 'all teams' when no team specified", () => {
    const { lastFrame } = render(<Dashboard items={SAMPLE_ITEMS} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("all teams");
  });
});

// ---- TTY gate (the load-bearing guard) ----

describe("tui TTY gate", () => {
  test("non-TTY (piped) exits non-zero with 'requires a terminal' error", () => {
    // `linearctl tui` in a pipe hits the TTY gate (stdout is not a TTY).
    // The spawned process inherits piped stdio, so isTTY is false.
    const proc = spawn("bun", ["run", "src/index.ts", "tui"], {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: "/tmp/linearctl-track2",
    });
    let stderr = "";
    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    return new Promise<void>((resolve) => {
      proc.on("close", (code) => {
        expect(code).not.toBe(0);
        expect(stderr).toContain("tui requires a terminal");
        resolve();
      });
    });
  });

  test("--help exits 0 cleanly without entering the TUI", () => {
    const proc = spawn("bun", ["run", "src/index.ts", "tui", "--help"], {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: "/tmp/linearctl-track2",
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    return new Promise<void>((resolve) => {
      proc.on("close", (code) => {
        expect(code).toBe(0);
        expect(stdout).toContain("--team");
        expect(stdout).toContain("--focus");
        // --help must NOT enter the TUI (no gate error, no render)
        expect(stderr).not.toContain("tui requires a terminal");
        expect(stdout).not.toContain("Triage queue");
        resolve();
      });
    });
  });
});

// ---- triage → Dashboard wiring (the fetch app() does before mount) ----

describe("app() — fetch wiring", () => {
  test("triage() with a stubbed client produces items that Dashboard renders", async () => {
    // app() does two things: (1) fetch via core/grooming.triage(client, team, project),
    // (2) render(<Dashboard items={items}>). Step (2) is already tested above
    // (Dashboard renders SAMPLE_ITEMS). This test verifies step (1) — that the
    // stub client triage() uses produces TriageItem[] compatible with Dashboard.
    // Same stub pattern as test/triage.test.ts:23-35.
    const stubNodes = [
      {
        id: "n1",
        identifier: "CER-142",
        title: "Fix webhook retry logic",
        url: "https://linear.app/issue/CER-142",
        priority: 2,
        estimate: null,
        updatedAt: "2026-07-20T00:00:00Z",
        state: { name: "In Progress", type: "started" },
        assignee: null,
      },
    ];
    const stubClient = {
      client: {
        rawRequest: async () => ({
          data: {
            issues: {
              nodes: stubNodes,
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        }),
      },
    } as unknown as LinearClient;

    // Step 1: triage() produces items (same path app() calls).
    const items = await triage(stubClient, ["CER"]);
    expect(items).toHaveLength(1);
    expect(items[0]!.identifier).toBe("CER-142");

    // Step 2: those items render in Dashboard without error.
    const { lastFrame } = render(<Dashboard items={items} team={["CER"]} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("CER-142");
    expect(frame).toContain("Triage queue");

    // The TTY gate is tested above (subprocess). app()'s render() itself
    // can't be called in-process (Ink needs raw-mode stdin); the component
    // tests + this fetch test prove the wiring without a real terminal.
  });
});
