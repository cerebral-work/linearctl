import { describe, expect, test } from "bun:test";
import { buildStoryDescription } from "../src/lib/story.js";

describe("buildStoryDescription", () => {
  test("nothing supplied → undefined (title-only park)", () => {
    expect(buildStoryDescription({ title: "t" })).toBeUndefined();
  });

  test("full scaffold", () => {
    expect(
      buildStoryDescription({
        title: "Guided tour",
        persona: "new visitor",
        why: "I understand what Cerebral offers",
        acceptance: ["Given a first visit, a 3-step tour appears"],
      }),
    ).toBe(
      [
        "As a new visitor,",
        "I want Guided tour,",
        "so that I understand what Cerebral offers.",
        "",
        "## Acceptance criteria",
        "- Given a first visit, a 3-step tour appears",
      ].join("\n"),
    );
  });

  test("want overrides title; no why → period, no so-that line", () => {
    const d = buildStoryDescription({ title: "t", persona: "dev", want: "a faster build" });
    expect(d).toBe("As a dev,\nI want a faster build.");
  });

  test("acceptance only → just the criteria section; blank lines dropped", () => {
    expect(buildStoryDescription({ title: "t", acceptance: ["one", "", "  two  "] })).toBe(
      "## Acceptance criteria\n- one\n- two",
    );
  });
});
