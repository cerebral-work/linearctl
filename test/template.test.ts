import { describe, expect, test } from "bun:test";
import {
  parseTemplate,
  templateVars,
  renderTemplate,
  parseVarFlags,
} from "../src/lib/template.js";

const RAW = `---
name: bug
title: "bug: {{ summary }}"
labels: [bug, mesh]
---
## Repro

{{ repro }}

## Root cause

{{ root_cause | "TBD" }}
`;

describe("parseTemplate", () => {
  test("frontmatter + body split; quoted title unwrapped; labels parsed", () => {
    const t = parseTemplate(RAW, "fallback");
    expect(t.name).toBe("bug");
    expect(t.title).toBe("bug: {{ summary }}");
    expect(t.labels).toEqual(["bug", "mesh"]);
    expect(t.body.startsWith("## Repro")).toBe(true);
  });

  test("missing frontmatter or title throws", () => {
    expect(() => parseTemplate("no frontmatter", "x")).toThrow(/frontmatter/);
    expect(() => parseTemplate("---\nname: x\n---\nbody", "x")).toThrow(/title/);
  });
});

describe("templateVars", () => {
  test("collects distinct vars with defaults", () => {
    const vars = templateVars(parseTemplate(RAW, "bug"));
    expect(vars).toEqual([
      { name: "summary" },
      { name: "repro" },
      { name: "root_cause", default: "TBD" },
    ]);
  });
});

describe("renderTemplate", () => {
  test("substitutes values and defaults", () => {
    const r = renderTemplate(parseTemplate(RAW, "bug"), {
      summary: "exit code wrong",
      repro: "run it",
    });
    expect(r.title).toBe("bug: exit code wrong");
    expect(r.description).toContain("run it");
    expect(r.description).toContain("TBD");
    expect(r.description).not.toContain("{{");
  });

  test("missing required vars fail loud, all listed", () => {
    expect(() => renderTemplate(parseTemplate(RAW, "bug"), {})).toThrow(
      /summary, repro/,
    );
  });
});

describe("parseVarFlags", () => {
  test("key=value pairs; value may contain '='", () => {
    expect(parseVarFlags(["a=1", "b=x=y"])).toEqual({ a: "1", b: "x=y" });
    expect(() => parseVarFlags(["novalue"])).toThrow(/key=value/);
  });
});
