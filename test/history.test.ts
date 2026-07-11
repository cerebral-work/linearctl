import { describe, expect, test } from "bun:test";
import { normalizeTimeline, type HistoryNode } from "../src/core/history.js";

const node = (over: Partial<HistoryNode>): HistoryNode => ({
  createdAt: "2026-07-10T10:00:00Z",
  actor: { displayName: "chris" },
  fromState: null,
  toState: null,
  fromAssignee: null,
  toAssignee: null,
  fromPriority: null,
  toPriority: null,
  fromTitle: null,
  toTitle: null,
  updatedDescription: null,
  addedLabelIds: null,
  removedLabelIds: null,
  fromProject: null,
  toProject: null,
  ...over,
});

const base = {
  createdAt: "2026-07-08T14:02:00Z",
  creator: { displayName: "chris" },
  comments: [],
};

describe("normalizeTimeline", () => {
  test("always leads with the create event", () => {
    const e = normalizeTimeline({ ...base, history: [] });
    expect(e).toEqual([
      { type: "create", at: "2026-07-08T14:02:00Z", actor: "chris", detail: "created" },
    ]);
  });

  test("one node carrying state + assignee yields two events", () => {
    const e = normalizeTimeline({
      ...base,
      history: [
        node({
          fromState: { name: "Backlog" },
          toState: { name: "In Progress" },
          toAssignee: { displayName: "chris" },
        }),
      ],
    });
    expect(e.map((x) => x.type)).toEqual(["create", "stateChange", "assignment"]);
    expect(e[1].detail).toBe("state: Backlog → In Progress");
    expect(e[2].detail).toBe("assigned: chris");
  });

  test("priority renders names; labels resolve through the supplied lookup", () => {
    const e = normalizeTimeline(
      {
        ...base,
        history: [
          node({ fromPriority: 0, toPriority: 2 }),
          node({ addedLabelIds: ["id-1"], removedLabelIds: ["id-2"] }),
        ],
      },
      (id) => ({ "id-1": "bug", "id-2": "stale" })[id] ?? id,
    );
    expect(e[1].detail).toBe("priority: None → High");
    expect(e[2].detail).toBe("labels: +bug −stale");
  });

  test("comments merge chronologically; bodies collapse whitespace and truncate", () => {
    const e = normalizeTimeline({
      ...base,
      history: [node({ updatedDescription: true, createdAt: "2026-07-10T12:00:00Z" })],
      comments: [
        { createdAt: "2026-07-09T09:00:00Z", user: { displayName: "marc" }, body: "a\n  b" + "x".repeat(300) },
      ],
    });
    expect(e.map((x) => x.type)).toEqual(["create", "comment", "description"]);
    expect(e[1].actor).toBe("marc");
    expect(e[1].detail.length).toBeLessThanOrEqual("comment: ".length + 201);
    expect(e[1].detail).toContain("a b");
  });
});
