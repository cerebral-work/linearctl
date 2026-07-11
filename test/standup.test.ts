import { describe, expect, test } from "bun:test";
import { renderStandup } from "../src/commands/standup.js";

describe("renderStandup", () => {
  test("maps state types to sections, skips backlog noise, tags assignees", () => {
    const md = renderStandup(
      {
        since: "x",
        total: 3,
        groups: [
          { type: "completed", count: 1, items: [{ identifier: "CER-1", title: "Shipped it", state: "Done", assignee: "chris", url: "u" }] },
          { type: "started", count: 1, items: [{ identifier: "CER-2", title: "Doing it", state: "In Progress", assignee: null, url: "u" }] },
          { type: "backlog", count: 1, items: [{ identifier: "CER-3", title: "Someday", state: "Backlog", assignee: null, url: "u" }] },
        ],
      },
      "24h",
    );
    expect(md).toContain("**Done** (1)");
    expect(md).toContain("- CER-1 Shipped it — chris");
    expect(md).toContain("**In progress** (1)");
    expect(md).not.toContain("Someday");
  });
});
