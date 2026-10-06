import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOOK = join(import.meta.dir, "..", ".claude", "hooks", "guard-main-push.sh");

interface HookResult {
  denied: boolean;
  output: string;
}

function runHook(command: string): HookResult {
  const input = JSON.stringify({ tool_input: { command } });
  const proc = Bun.spawnSync(["bash", HOOK], {
    stdin: new TextEncoder().encode(input),
    cwd: import.meta.dir,
    env: { ...process.env },
  });
  const output = new TextDecoder().decode(proc.stdout);
  return { denied: output.includes('"deny"'), output };
}

/** Create a temp git repo on the given branch for -C tests. */
function makeRepo(branch: string): string {
  const dir = mkdtempSync(join(tmpdir(), "guard-test-"));
  Bun.spawnSync(["git", "init", "--initial-branch", branch, dir]);
  Bun.spawnSync(["git", "-C", dir, "commit", "--allow-empty", "-m", "init"]);
  return dir;
}

describe("guard-main-push hook", () => {
  // Ticket matrix (verbatim from ticket):
  // | command | hook | correct |
  // | `git push origin main` | DENY | DENY |
  // | `git -C /tmp/x push origin main` | ALLOW | DENY (false negative) |
  // | `git -C /tmp/x push origin feat:refs/heads/feat` | ALLOW | ALLOW |
  // | `git push origin feat` (session dir on main, push from a feature worktree) | DENY | ALLOW (false positive) |

  test("denies: git push origin main", () => {
    const r = runHook("git push origin main");
    expect(r.denied).toBe(true);
  });

  test("denies: git -C <dir> push origin main", () => {
    const r = runHook("git -C /tmp/x push origin main");
    expect(r.denied).toBe(true);
  });

  test("allows: git -C <dir> push origin feat:refs/heads/feat", () => {
    const r = runHook("git -C /tmp/x push origin feat:refs/heads/feat");
    expect(r.denied).toBe(false);
  });

  test("allows: git push origin feat (refspec is feature branch)", () => {
    // Even when the session directory is on main, pushing a feature branch
    // refspec should be allowed — the old hook falsely denied this.
    const r = runHook("git push origin feat");
    expect(r.denied).toBe(false);
  });

  test("allows: non-git command", () => {
    const r = runHook("ls -la");
    expect(r.denied).toBe(false);
  });

  test("allows: override marker present", () => {
    const r = runHook("git push origin main # allow-direct-push");
    expect(r.denied).toBe(false);
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
      const r = runHook(`git -C ${mainDir} push`);
      expect(r.denied).toBe(true);
    });

    test("allows: git -C <repo-on-feat> push", () => {
      const r = runHook(`git -C ${featDir} push`);
      expect(r.denied).toBe(false);
    });
  });
});
