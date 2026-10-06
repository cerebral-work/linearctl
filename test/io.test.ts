import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "bun:test";
import { requireBody } from "../src/lib/io.js";

// CER-1872: `--desc -` with an empty stdin silently created title-only
// issues. `requireBody` is the guard every `-` body site now goes through.
describe("requireBody", () => {
  test("passes a non-empty body through unchanged", () => {
    expect(requireBody("--desc -", "hello **world**")).toBe("hello **world**");
  });

  test("throws on an empty body, naming the flag", () => {
    expect(() => requireBody("--desc -", "")).toThrow(/--desc -: stdin was empty/);
  });

  test("throws for --body - with an empty read", () => {
    expect(() => requireBody("--body -", "")).toThrow(/--body -: stdin was empty/);
  });

  test("preserves whitespace-bearing bodies (trimming is readStdin's job)", () => {
    expect(requireBody("--content -", "a\n\nb")).toBe("a\n\nb");
  });
});

/**
 * CER-2060 / CER-2133: under Bun, `for await (const chunk of process.stdin)`
 * returns EMPTY when stdin is a regular-file redirect (`< file`) once
 * commander is imported first, while pipes still work. `readStdin` reads fd 0
 * directly instead. These tests spawn a probe importing commander (the module
 * whose import triggered the failure) with stdin delivered three ways:
 * pipe, file redirect, and empty.
 */
const probe = `import "commander";
import { readStdin } from ${JSON.stringify(join(import.meta.dir, "../src/lib/io.ts"))};
process.stdout.write(JSON.stringify(await readStdin()));
`;

const dir = mkdtempSync(join(tmpdir(), "linearctl-io-"));
const probePath = join(dir, "probe.ts");
writeFileSync(probePath, probe);
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function runProbe(opts: { pipe?: string; file?: string }) {
  const args = [process.execPath, probePath];
  if (opts.file !== undefined) {
    // stdin = the file itself (a real fd redirect, not a pipe)
    const result = Bun.spawnSync(args, { stdin: Bun.file(opts.file), stdout: "pipe", stderr: "pipe" });
    return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() };
  }
  // spawnSync accepts the stdin payload directly as a pipe
  const result = Bun.spawnSync(args, { stdin: Buffer.from(opts.pipe ?? ""), stdout: "pipe", stderr: "pipe" });
  return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() };
}

describe("readStdin (spawned, commander imported)", () => {
  test("reads a pipe", () => {
    const r = runProbe({ pipe: "hello via pipe" });
    expect(r.err).toBe("");
    expect(JSON.parse(r.out)).toBe("hello via pipe");
  });

  test("reads a file redirect (CER-2133 regression)", () => {
    const body = "hello via redirect";
    const file = join(dir, "body.md");
    writeFileSync(file, body);
    const r = runProbe({ file });
    expect(r.err).toBe("");
    expect(JSON.parse(r.out)).toBe(body);
  });

  test("reads empty from an empty stdin (guard input stays reachable)", () => {
    const r = runProbe({ pipe: "" });
    expect(JSON.parse(r.out)).toBe("");
  });
});
