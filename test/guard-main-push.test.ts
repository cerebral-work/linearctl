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

  // --- Round 2: command substitution + refspec forms (probe-178b) ---

  test("denies: echo $(git push origin main)", () => {
    expect(runHook("echo $(git push origin main)").denied).toBe(true);
  });

  test("denies: echo `git push origin main` (backticks)", () => {
    expect(runHook("echo `git push origin main`").denied).toBe(true);
  });

  test("denies: git push origin main:main (colon refspec)", () => {
    expect(runHook("git push origin main:main").denied).toBe(true);
  });

  test("denies: git push origin feat:main (cross-branch refspec)", () => {
    expect(runHook("git push origin feat:main").denied).toBe(true);
  });

  test("denies: git push origin refs/heads/main", () => {
    expect(runHook("git push origin refs/heads/main").denied).toBe(true);
  });

  test("denies: git push origin :main (delete main)", () => {
    expect(runHook("git push origin :main").denied).toBe(true);
  });

  test("denies: git push --force origin main", () => {
    expect(runHook("git push --force origin main").denied).toBe(true);
  });

  test("denies: git push -u origin main", () => {
    expect(runHook("git push -u origin main").denied).toBe(true);
  });

  test("denies: git push origin master", () => {
    expect(runHook("git push origin master").denied).toBe(true);
  });

  test("denies: git -c core.x=y push origin main", () => {
    expect(runHook("git -c core.x=y push origin main").denied).toBe(true);
  });

  test("denies: GIT_DIR=/x git push origin main (env prefix)", () => {
    expect(runHook("GIT_DIR=/x git push origin main").denied).toBe(true);
  });

  test("denies: git push --mirror origin", () => {
    expect(runHook("git push --mirror origin").denied).toBe(true);
  });

  test("allows: git push origin main-feature (main is a prefix, not the ref)", () => {
    expect(runHook("git push origin main-feature").denied).toBe(false);
  });

  test("allows: git push origin feat/main (main in path position)", () => {
    expect(runHook("git push origin feat/main").denied).toBe(false);
  });

  test("allows: git status && echo done (no push)", () => {
    expect(runHook("git status && echo done").denied).toBe(false);
  });

  test("allows: gh pr merge 177 --merge (no git push)", () => {
    expect(runHook("gh pr merge 177 --merge").denied).toBe(false);
  });

  test("denies: backslash-newline continuation: git \\⏎ push origin main", () => {
    expect(runHook("git \\\npush origin main").denied).toBe(true);
  });

  test("denies: backslash-newline: git -C /tmp/x \\⏎ push origin main", () => {
    expect(runHook("git -C /tmp/x \\\npush origin main").denied).toBe(true);
  });

  test("denies: backslash-newline: git push \\⏎ origin main (feat repo)", () => {
    const dir = makeRepo("feat");
    try {
      expect(runHook(`git -C ${dir} push \\\norigin main`).denied).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("denies: backslash-newline: git push origin \\⏎ main (feat repo)", () => {
    const dir = makeRepo("feat");
    try {
      expect(runHook(`git -C ${dir} push origin \\\nmain`).denied).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("allows: backslash-newline: git push \\⏎ origin feat (feat repo)", () => {
    const dir = makeRepo("feat");
    try {
      expect(runHook(`git -C ${dir} push \\\norigin feat`).denied).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- Round 3: narrowed fail-closed ---

  test("allows: heredoc body prose mentioning git push origin feat", () => {
    // A heredoc body line of prose that names git+push but not main/master
    // should NOT be denied when the session is on a feature branch.
    const dir = makeRepo("feat");
    try {
      expect(
        runHook(`cd ${dir} && cat <<'EOF'\nnote: we will git push origin feat later\nEOF`).denied,
      ).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("denies: heredoc body prose mentioning git push origin main", () => {
    // Same prose but naming main — fail-closed applies.
    expect(
      runHook("cat <<'EOF'\nnote: we will git push origin main later\nEOF").denied,
    ).toBe(true);
  });

  test("denies: bash heredoc executing git push origin main", () => {
    // bash <<EOF executes its body — the body is a real command.
    expect(runHook("bash <<EOF\ngit push origin main\nEOF").denied).toBe(true);
  });
  test("performance: 16 KiB command containing 'git push' finishes under 300ms", () => {
    // A heredoc body containing the text `git push` — the hook must parse it
    // fast enough not to stall the harness.
    const body = "x".repeat(16_000);
    const cmd = `cat > /tmp/x <<'EOF'\ngit push is mentioned here\n${body}\nEOF\necho ok`;
    const input = JSON.stringify({ tool_input: { command: cmd } });
    const t0 = performance.now();
    const proc = Bun.spawnSync(["bash", HOOK], {
      stdin: new TextEncoder().encode(input),
      cwd: tmpdir(),
      env: { ...process.env },
    });
    const ms = performance.now() - t0;
    const output = new TextDecoder().decode(proc.stdout);
    // Heredoc body line "git push is mentioned here" is a segment, but
    // tokenizes to [git, push, is, ...] — first token is git, second is
    // push → the parser reads it as a bare `git push` with no refspec in a
    // non-git cwd → no main branch → ALLOW. Either way, speed is the point.
    expect(ms).toBeLessThan(300);
  });

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
