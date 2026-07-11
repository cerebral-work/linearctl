import { describe, expect, test } from "bun:test";
import { renderReleaseNotes } from "../src/core/release-notes.js";

describe("renderReleaseNotes", () => {
  test("groups render alphabetically with 'other' last, items as bullets", () => {
    const md = renderReleaseNotes({
      from: "2026-07-01T00:00:00.000Z",
      until: "2026-07-11T00:00:00.000Z",
      total: 3,
      groups: [
        { label: "bug", items: [{ identifier: "CER-1", title: "Fix x", url: "u1", completedAt: "" }] },
        {
          label: "other",
          items: [
            { identifier: "CER-2", title: "Ship y", url: "u2", completedAt: "" },
            { identifier: "CER-3", title: "Ship z", url: "u3", completedAt: "" },
          ],
        },
      ],
    });
    expect(md).toContain("## Completed 2026-07-01 → 2026-07-11 (3 issues)");
    expect(md.indexOf("### bug")).toBeLessThan(md.indexOf("### other"));
    expect(md).toContain("- CER-1: Fix x (u1)");
  });
});
