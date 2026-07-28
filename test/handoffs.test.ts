import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createHandoff,
  getHandoff,
  listHandoffs,
  resolveHandoff,
  serializeHandoff,
  parseFrontmatter,
  handoffId,
  resolveStore,
  DEFAULT_HANDOFF_STORE,
  HandoffError,
  type Handoff,
} from "../src/core/handoffs.js";
import {
  handoffBodySkeleton,
  missingSections,
  HANDOFF_SECTIONS,
} from "../src/lib/handoff-template.js";

/**
 * Handoff CRUD contract tests (Track 6 sub-feature B).
 *
 * Every test runs against a temp-dir store via the `dir:` option — the real
 * `~/.local/state/linearctl/handoffs/` is never written to. Mirrors the
 * temp-socket pattern in `test/operator.test.ts`.
 */
function tempStore(): string {
  return mkdtempSync(join(tmpdir(), "linearctl-handoff-test-"));
}

/** A handoff body that satisfies all four required sections. */
function completeBody(extra = ""): string {
  return [
    "## What landed",
    "OAuth scaffolding + auth verbs.",
    "",
    "## Verification",
    "- [x] typecheck clean",
    "- [x] 301 tests pass",
    "",
    "## Decisions",
    "Read client_id from 1Password always.",
    "",
    "## Next steps",
    "Merge PR #114, then start CER-1149.",
    "",
    extra,
  ].join("\n");
}

describe("handoffId", () => {
  test("slugifies title + date into a sortable id", () => {
    expect(handoffId("OAuth Scaffolding", "2026-07-28")).toBe(
      "2026-07-28-oauth-scaffolding",
    );
  });

  test("collapses non-alphanumerics to single hyphens", () => {
    expect(handoffId("Handoff: CER-1148 / OAuth!!", "2026-07-28")).toBe(
      "2026-07-28-handoff-cer-1148-oauth",
    );
  });

  test("falls back to 'handoff' when the title has no alphanumerics", () => {
    expect(handoffId("--- !!! ---", "2026-07-28")).toBe("2026-07-28-handoff");
  });
});

describe("resolveStore", () => {
  test("explicit dir resolves to an absolute path", () => {
    expect(resolveStore("/tmp/x")).toBe("/tmp/x");
    expect(resolveStore("relative/dir")).toMatch(/relative\/dir$/);
  });

  test("default is the XDG state dir shared with the operator socket", () => {
    expect(DEFAULT_HANDOFF_STORE).toBe(
      `${process.env.HOME ?? ""}/.local/state/linearctl/handoffs`,
    );
    expect(resolveStore()).toBe(DEFAULT_HANDOFF_STORE);
  });
});

describe("serializeHandoff / parseFrontmatter round-trip", () => {
  test("frontmatter + body survives a serialize → parse cycle", () => {
    const handoff: Handoff = {
      id: "2026-07-28-oauth-scaffolding",
      date: "2026-07-28",
      title: "OAuth Scaffolding",
      pr: "#112",
      ticket: "CER-1148",
      status: "active",
      body: "## What landed\n\nstuff\n",
    };
    const md = serializeHandoff(handoff);
    const parsed = parseFrontmatter(md);
    expect(parsed).not.toBeNull();
    const fm = parsed!.frontmatter;
    expect(fm.id).toBe(handoff.id);
    expect(fm.date).toBe(handoff.date);
    expect(fm.title).toBe(handoff.title);
    expect(fm.pr).toBe(handoff.pr);
    expect(fm.ticket).toBe(handoff.ticket);
    expect(fm.status).toBe("active");
    expect(parsed!.body).toBe("## What landed\n\nstuff");
  });

  test("PR ref with # is quoted so YAML doesn't read it as a comment", () => {
    const md = serializeHandoff({
      id: "2026-07-28-x",
      date: "2026-07-28",
      title: "T",
      pr: "#112",
      status: "active",
      body: "b",
    });
    expect(md).toContain('pr: "#112"');
    const parsed = parseFrontmatter(md)!.frontmatter;
    expect(parsed.pr).toBe("#112");
  });

  test("frontmatter without pr/ticket omits those keys cleanly", () => {
    const md = serializeHandoff({
      id: "2026-07-28-x",
      date: "2026-07-28",
      title: "T",
      status: "resolved",
      body: "b",
    });
    expect(md).not.toContain("pr:");
    expect(md).not.toContain("ticket:");
    const parsed = parseFrontmatter(md)!.frontmatter;
    expect(parsed.pr).toBeUndefined();
    expect(parsed.ticket).toBeUndefined();
  });

  test("parseFrontmatter returns null when no frontmatter block is present", () => {
    expect(parseFrontmatter("just markdown\nno frontmatter")).toBeNull();
  });

  test("CRLF line endings parse the same as LF (resilience for editor round-trips)", () => {
    const md = serializeHandoff({
      id: "2026-07-28-x",
      date: "2026-07-28",
      title: "T",
      status: "active",
      body: "b",
    }).replace(/\n/g, "\r\n");
    const parsed = parseFrontmatter(md);
    expect(parsed).not.toBeNull();
    expect(parsed!.frontmatter.id).toBe("2026-07-28-x");
  });
});

describe("createHandoff", () => {
  test("persists a markdown file with derived id + active status", () => {
    const store = tempStore();
    const created = createHandoff(
      { title: "OAuth Scaffolding", pr: "#112", ticket: "CER-1148", body: completeBody() },
      { dir: store, date: "2026-07-28" },
    );
    expect(created.id).toBe("2026-07-28-oauth-scaffolding");
    expect(created.status).toBe("active");
    expect(created.pr).toBe("#112");
    expect(created.ticket).toBe("CER-1148");

    const file = join(store, "2026-07-28-oauth-scaffolding.md");
    expect(existsSync(file)).toBe(true);
    const raw = readFileSync(file, "utf-8");
    expect(raw).toContain("id: 2026-07-28-oauth-scaffolding");
    expect(raw).toContain("status: active");
    expect(raw).toContain('pr: "#112"');
    expect(raw).toContain("## What landed");
  });

  test("round-trips through getHandoff: every field survives the file", () => {
    const store = tempStore();
    const created = createHandoff(
      { title: "OAuth Scaffolding", ticket: "CER-1148", body: completeBody() },
      { dir: store, date: "2026-07-28" },
    );
    const fetched = getHandoff(created.id, { dir: store });
    expect(fetched).toEqual(created);
  });

  test("creates the store dir if it doesn't exist (recursive)", () => {
    const store = join(tempStore(), "nested", "handoffs");
    expect(existsSync(store)).toBe(false);
    const created = createHandoff(
      { title: "T", body: completeBody() },
      { dir: store, date: "2026-07-28" },
    );
    expect(existsSync(store)).toBe(true);
    expect(created.id).toBe("2026-07-28-t");
  });

  test("refuses to overwrite an existing id (idempotent create)", () => {
    const store = tempStore();
    const input = { title: "OAuth", body: completeBody() };
    createHandoff(input, { dir: store, date: "2026-07-28" });
    expect(() => createHandoff(input, { dir: store, date: "2026-07-28" })).toThrow(
      HandoffError,
    );
    expect(() => createHandoff(input, { dir: store, date: "2026-07-28" })).toThrow(
      /already exists/,
    );
  });

  test("rejects empty title before touching the filesystem", () => {
    const store = tempStore();
    expect(() =>
      createHandoff({ title: "   ", body: completeBody() }, { dir: store }),
    ).toThrow(/title is required/);
    expect(listHandoffs({ dir: store })).toHaveLength(0);
  });

  test("rejects empty body before touching the filesystem", () => {
    const store = tempStore();
    expect(() =>
      createHandoff({ title: "T", body: "   " }, { dir: store, date: "2026-07-28" }),
    ).toThrow(/body is required/);
    expect(listHandoffs({ dir: store })).toHaveLength(0);
  });
});

describe("getHandoff", () => {
  test("throws HandoffError when the id doesn't exist", () => {
    const store = tempStore();
    expect(() => getHandoff("nope-2026-01-01", { dir: store })).toThrow(HandoffError);
    expect(() => getHandoff("nope-2026-01-01", { dir: store })).toThrow(/no handoff/);
  });

  test("throws HandoffError on a frontmatter-less file", () => {
    const store = tempStore();
    writeFileSync(join(store, "2026-07-28-bare.md"), "# just a title\n\nno fm\n");
    expect(() => getHandoff("2026-07-28-bare", { dir: store })).toThrow(HandoffError);
  });

  test("throws HandoffError on an invalid status value", () => {
    const store = tempStore();
    writeFileSync(
      join(store, "2026-07-28-bad.md"),
      "---\nid: 2026-07-28-bad\ndate: 2026-07-28\ntitle: T\nstatus: maybe\n---\n\nb\n",
    );
    expect(() => getHandoff("2026-07-28-bad", { dir: store })).toThrow(/invalid status/);
  });
});

describe("listHandoffs", () => {
  test("returns [] when the store dir doesn't exist (fresh install)", () => {
    expect(listHandoffs({ dir: join(tempStore(), "does-not-exist") })).toEqual([]);
  });

  test("returns all handoffs, newest-first by date then id", () => {
    const store = tempStore();
    createHandoff(
      { title: "Older", body: completeBody() },
      { dir: store, date: "2026-07-01" },
    );
    createHandoff(
      { title: "Newer", body: completeBody() },
      { dir: store, date: "2026-07-28" },
    );
    createHandoff(
      { title: "Middle", body: completeBody() },
      { dir: store, date: "2026-07-15" },
    );
    const list = listHandoffs({ dir: store });
    expect(list.map((h) => h.id)).toEqual([
      "2026-07-28-newer",
      "2026-07-15-middle",
      "2026-07-01-older",
    ]);
  });

  test("same-date handoffs sort by id desc (lexically newest first)", () => {
    const store = tempStore();
    createHandoff(
      { title: "alpha", body: completeBody() },
      { dir: store, date: "2026-07-28" },
    );
    createHandoff(
      { title: "zulu", body: completeBody() },
      { dir: store, date: "2026-07-28" },
    );
    const list = listHandoffs({ dir: store });
    expect(list.map((h) => h.id)).toEqual([
      "2026-07-28-zulu",
      "2026-07-28-alpha",
    ]);
  });

  test("skips non-.md files and README.md without failing the whole list", () => {
    const store = tempStore();
    createHandoff(
      { title: "Real", body: completeBody() },
      { dir: store, date: "2026-07-28" },
    );
    writeFileSync(join(store, "README.md"), "# not a handoff\n");
    writeFileSync(join(store, "notes.txt"), "not markdown\n");
    const list = listHandoffs({ dir: store });
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe("2026-07-28-real");
  });
});

describe("resolveHandoff", () => {
  test("flips status active → resolved and persists the change", () => {
    const store = tempStore();
    const created = createHandoff(
      { title: "OAuth", body: completeBody() },
      { dir: store, date: "2026-07-28" },
    );
    expect(created.status).toBe("active");

    const resolved = resolveHandoff(created.id, { dir: store });
    expect(resolved.status).toBe("resolved");
    expect(resolved.id).toBe(created.id);

    // Re-read from disk: the persisted status flipped.
    const refetched = getHandoff(created.id, { dir: store });
    expect(refetched.status).toBe("resolved");
  });

  test("preserves the body verbatim on resolve (status change only)", () => {
    const store = tempStore();
    const body = completeBody("## Extra\n\nunchanged\n");
    const created = createHandoff(
      { title: "OAuth", body },
      { dir: store, date: "2026-07-28" },
    );
    const resolved = resolveHandoff(created.id, { dir: store });
    expect(resolved.body).toBe(created.body);
    // The only diff between the created + resolved files is the status line.
    const raw = readFileSync(join(store, `${created.id}.md`), "utf-8");
    expect(raw).toContain("status: resolved");
    expect(raw).toContain("## Extra");
  });

  test("refuses to resolve an already-resolved handoff (idempotent-safe)", () => {
    const store = tempStore();
    const created = createHandoff(
      { title: "OAuth", body: completeBody() },
      { dir: store, date: "2026-07-28" },
    );
    resolveHandoff(created.id, { dir: store });
    expect(() => resolveHandoff(created.id, { dir: store })).toThrow(HandoffError);
    expect(() => resolveHandoff(created.id, { dir: store })).toThrow(/already resolved/);
  });

  test("throws HandoffError when resolving a missing handoff", () => {
    const store = tempStore();
    expect(() => resolveHandoff("nope", { dir: store })).toThrow(HandoffError);
  });
});

describe("handoff-template", () => {
  test("skeleton contains all four required sections in order", () => {
    const skeleton = handoffBodySkeleton();
    for (const section of HANDOFF_SECTIONS) {
      expect(skeleton).toContain(section);
    }
    // Sections appear in the canonical order (What landed → Verification → Decisions → Next steps).
    const positions = HANDOFF_SECTIONS.map((s) => skeleton.indexOf(s));
    for (let i = 1; i < positions.length; i++) {
      expect(positions[i]).toBeGreaterThan(positions[i - 1]);
    }
  });

  test("skeleton includes the verification checklist items", () => {
    const skeleton = handoffBodySkeleton();
    expect(skeleton).toContain("`bun run typecheck` clean");
    expect(skeleton).toContain("`bun test` passes");
    expect(skeleton).toContain("`bun build`");
  });

  test("skeleton includes a ref line when pr/ticket are provided", () => {
    const skeleton = handoffBodySkeleton({ pr: "#112", ticket: "CER-1148" });
    expect(skeleton).toContain("ref: CER-1148 / #112");
  });

  test("skeleton omits the ref line when no pr/ticket", () => {
    const skeleton = handoffBodySkeleton();
    expect(skeleton).not.toContain("ref:");
  });

  test("missingSections reports which required headings are absent", () => {
    expect(missingSections("## What landed\n\nx\n## Next steps\n")).toEqual([
      "## Verification",
      "## Decisions",
    ]);
  });

  test("missingSections returns [] for a complete body", () => {
    expect(missingSections(completeBody())).toEqual([]);
  });

  test("a handoff created from the skeleton passes missingSections", () => {
    const store = tempStore();
    const body = handoffBodySkeleton({ pr: "#114", ticket: "CER-1188" });
    const created = createHandoff(
      { title: "Agent Facility", pr: "#114", ticket: "CER-1188", body },
      { dir: store, date: "2026-07-28" },
    );
    // The skeleton includes all four headings, so missingSections is empty.
    expect(missingSections(created.body)).toEqual([]);
  });
});
