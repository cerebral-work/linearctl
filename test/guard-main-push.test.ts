import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOOK = join(import.meta.dir, "..", ".claude", "hooks", "guard-main-push.sh");

interface HookResult {
  denied: boolean;
  output: string;
}

/**
 * Feed a synthetic PreToolUse input to the hook. Nothing is pushed.
 * cwd is a non-git directory so the session checkout never leaks in;
 * repo-dependent rows pass their repo explicitly.
 */
function runHook(command: string): HookResult {
  const input = JSON.stringify({ tool_input: { command } });
  const proc = Bun.spawnSync(["bash", HOOK], {
    stdin: new TextEncoder().encode(input),
    cwd: tmpdir(),
    env: { ...process.env },
  });
  const output = new TextDecoder().decode(proc.stdout);
  return { denied: output.includes('"deny"'), output };
}

/** Create a temp git repo on the given branch. */
function makeRepo(branch: string): string {
  const dir = mkdtempSync(join(tmpdir(), "guard-test-"));
  Bun.spawnSync(["git", "init", "--initial-branch", branch, dir]);
  Bun.spawnSync(["git", "-C", dir, "commit", "--allow-empty", "-m", "init"]);
  return dir;
}

describe("guard-main-push hook", () => {
  // Original ticket matrix (CER-2607):
  // | `git push origin main`                        | DENY  |
  // | `git -C /tmp/x push origin main`             | DENY  | (was false negative)
  // | `git -C /tmp/x push origin feat:refs/heads/feat` | ALLOW |
  // | `git push origin feat` (session dir on main) | ALLOW | (was false positive)

  // Critic round-1 probe matrix (14 rows, PR #178 review):
  // command                                        | want
  // git push origin main                           | DENY
  // git -C /tmp/x push origin main                 | DENY
  // git -C <feat repo> push origin feat            | ALLOW
  // cd /tmp && git push origin main                | DENY
  // git fetch origin && git push origin main       | DENY
  // true; git push origin main                     | DENY
  // echo hi NEWLINE git push origin main           | DENY
  // timeout 30 git push origin main                | DENY
  // rtk git push origin main                       | DENY
  // bash -c 'git push origin main'                 | DENY
  // git push origin +main                          | DENY
  // git push origin HEAD (on main)                 | DENY
  // git --git-dir /x/.git push origin main         | DENY
  // cat b.md | cortex-msg send x 'notes about git push origin main' | ALLOW

  test("denies: git push origin main", () => {
    expect(runHook("git push origin main").denied).toBe(true);
  });

  test("denies: git -C <dir> push origin main", () => {
    expect(runHook("git -C /tmp/x push origin main").denied).toBe(true);
  });

  test("allows: git -C <feat repo> push origin feat", () => {
    const dir = makeRepo("feat");
    try {
      expect(runHook(`git -C ${dir} push origin feat`).denied).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("denies: cd /tmp && git push origin main", () => {
    expect(runHook("cd /tmp && git push origin main").denied).toBe(true);
  });

  test("denies: git fetch origin && git push origin main", () => {
    expect(runHook("git fetch origin && git push origin main").denied).toBe(true);
  });

  test("denies: true; git push origin main", () => {
    expect(runHook("true; git push origin main").denied).toBe(true);
  });

  test("denies: git push origin main after a newline", () => {
    expect(runHook("echo hi\ngit push origin main").denied).toBe(true);
  });

  test("denies: timeout 30 git push origin main", () => {
    expect(runHook("timeout 30 git push origin main").denied).toBe(true);
  });

  test("denies: rtk git push origin main", () => {
    expect(runHook("rtk git push origin main").denied).toBe(true);
  });

  test("denies: bash -c 'git push origin main'", () => {
    expect(runHook("bash -c 'git push origin main'").denied).toBe(true);
  });

  test("denies: git push origin +main (force prefix)", () => {
    expect(runHook("git push origin +main").denied).toBe(true);
  });

  test("denies: git push origin HEAD when resolved repo is on main", () => {
    const dir = makeRepo("main");
    try {
      expect(runHook(`git -C ${dir} push origin HEAD`).denied).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("allows: git push origin HEAD when resolved repo is on feat", () => {
    const dir = makeRepo("feat");
    try {
      expect(runHook(`git -C ${dir} push origin HEAD`).denied).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("denies: git --git-dir /x/.git push origin main", () => {
    expect(runHook("git --git-dir /x/.git push origin main").denied).toBe(true);
  });

  test("allows: git push mention inside a quoted argument to another command", () => {
    expect(
      runHook("cat body.md | cortex-msg send x 'notes about git push origin main'").denied,
    ).toBe(false);
  });

  // --- Original ticket rows and earlier edge cases ---

  test("allows: git -C <dir> push origin feat:refs/heads/feat", () => {
    expect(runHook("git -C /tmp/x push origin feat:refs/heads/feat").denied).toBe(false);
  });

  test("allows: git push origin feat (refspec is feature branch)", () => {
    // Even when the session directory is on main, pushing a feature branch
    // refspec should be allowed — the old hook falsely denied this.
    expect(runHook("git push origin feat").denied).toBe(false);
  });

  test("allows: non-git command", () => {
    expect(runHook("ls -la").denied).toBe(false);
  });

  test("allows: override marker present", () => {
    expect(runHook("git push origin main # allow-direct-push").denied).toBe(false);
  });

  describe("bare push (no refspec) resolves branch from -C target", () => {
    let mainDir: string;
    let featDir: string;

    beforeAll(() => {
      mainDir = makeRepo("main");
      featDir = makeRepo("feat");
    });

    afterAll(() => {
      rmSync(mainDir, { recursive: true, force: true });
      rmSync(featDir, { recursive: true, force: true });
    });

    test("denies: git -C <repo-on-main> push", () => {
      expect(runHook(`git -C ${mainDir} push`).denied).toBe(true);
    });

    test("allows: git -C <repo-on-feat> push", () => {
      expect(runHook(`git -C ${featDir} push`).denied).toBe(false);
    });

    test("denies: cd <repo-on-main> && git push", () => {
      expect(runHook(`cd ${mainDir} && git push`).denied).toBe(true);
    });

    test("allows: cd <repo-on-feat> && git push", () => {
      expect(runHook(`cd ${featDir} && git push`).denied).toBe(false);
    });
  });
});
