import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  registerRole,
  getRole,
  listRoles,
  assertRoleMayAct,
  cadenceToMs,
  type RoleDescriptor,
  type RoleRunner,
} from "../src/core/role-catalog.js";
import {
  assertWithinGuardrails,
  isGated,
  GuardrailError,
  type ProposedAction,
} from "../src/core/guardrails.js";
import { scheduleRole } from "../src/core/scheduler.js";

/**
 * Role catalog + scheduler + guardrails contract tests (CER-1188 / Track 1).
 *
 * No network. The registry is static config; the scheduler is a timer + drain;
 * the guardrail gate is a pure predicate + throw. All three are exercised with
 * stubs, mirroring the operator.test.ts stub-deps pattern.
 */

describe("role-catalog registry", () => {
  test("intake-triage + grooming are registered in the first slice", () => {
    const names = listRoles();
    expect(names).toContain("intake-triage");
    expect(names).toContain("grooming");
  });

  test("getRole returns the descriptor with D4 cadence + D1 intake", () => {
    const triage = getRole("intake-triage");
    expect(triage.cadence).toBe("daily");
    expect(triage.intake).toBe("poll-project");
    expect(triage.guardrails).toContain("comment");

    const grooming = getRole("grooming");
    expect(grooming.cadence).toBe("daily");
    expect(grooming.guardrails).toEqual(expect.arrayContaining(["comment", "label"]));
  });

  test("getRole throws on an unknown name with the known list", () => {
    expect(() => getRole("nonexistent-role")).toThrow(/unknown role "nonexistent-role"/);
    expect(() => getRole("nonexistent-role")).toThrow(/intake-triage/);
  });

  test("registerRole is idempotent (re-register overwrites)", () => {
    registerRole("test-temp", { cadence: "daily", intake: "poll-project", guardrails: ["comment"] });
    registerRole("test-temp", { cadence: "weekly", intake: "both", guardrails: ["label"] });
    const role = getRole("test-temp");
    expect(role.cadence).toBe("weekly");
    expect(role.intake).toBe("both");
    expect(role.guardrails).toEqual(["label"]);
  });

  test("cadenceToMs maps D4 cadences to the right intervals", () => {
    expect(cadenceToMs("daily")).toBe(86_400_000);
    expect(cadenceToMs("weekly")).toBe(7 * 86_400_000);
    expect(cadenceToMs("biweekly")).toBe(14 * 86_400_000);
  });
});

describe("guardrails — the D2 enforcement gate", () => {
  test("allows autonomous action types", () => {
    const autonomous: ProposedAction[] = [
      { kind: "comment", target: "CER-123" },
      { kind: "label", target: "stale" },
      { kind: "file-issue", target: "CER" },
      { kind: "update-issue", target: "CER-456" },
      { kind: "merge-own-green-pr", target: "#100" },
    ];
    for (const action of autonomous) {
      expect(() => assertWithinGuardrails(action)).not.toThrow();
      expect(isGated(action.kind)).toBe(false);
    }
  });

  test("throws on merge-to-main (D2 gated)", () => {
    const action: ProposedAction = { kind: "merge-to-main", target: "main" };
    expect(() => assertWithinGuardrails(action)).toThrow(GuardrailError);
    expect(() => assertWithinGuardrails(action)).toThrow(/requires operator approval/);
    expect(isGated("merge-to-main")).toBe(true);
  });

  test("throws on release (release-manager is never autonomous, even under D2)", () => {
    const action: ProposedAction = { kind: "release", target: "v0.8.0" };
    expect(() => assertWithinGuardrails(action)).toThrow(GuardrailError);
    expect(() => assertWithinGuardrails(action)).toThrow(/gated/);
  });

  test("throws on external-send", () => {
    const action: ProposedAction = { kind: "external-send", target: "Slack #releases" };
    expect(() => assertWithinGuardrails(action)).toThrow(GuardrailError);
  });

  test("throws on cross-repo", () => {
    const action: ProposedAction = { kind: "cross-repo", target: "cerebral/other-repo" };
    expect(() => assertWithinGuardrails(action)).toThrow(GuardrailError);
  });

  test("throws on secret-rotate / secret-delete", () => {
    expect(() => assertWithinGuardrails({ kind: "secret-rotate" })).toThrow(GuardrailError);
    expect(() => assertWithinGuardrails({ kind: "secret-delete" })).toThrow(GuardrailError);
  });

  test("GuardrailError carries the kind + target in the message", () => {
    try {
      assertWithinGuardrails({ kind: "release", target: "v1.0.0" });
      throw new Error("should have thrown");
    } catch (err) {
      const e = err as GuardrailError;
      expect(e.name).toBe("GuardrailError");
      expect(e.message).toContain("release");
      expect(e.message).toContain("v1.0.0");
    }
  });
});

describe("assertRoleMayAct — per-role permitted set + guardrail", () => {
  test("grooming may label (in-set + autonomous)", () => {
    const grooming = getRole("grooming");
    expect(() => assertRoleMayAct(grooming, { kind: "label" })).not.toThrow();
    expect(() => assertRoleMayAct(grooming, { kind: "comment" })).not.toThrow();
  });

  test("intake-triage may comment but NOT label (out-of-set)", () => {
    const triage = getRole("intake-triage");
    expect(() => assertRoleMayAct(triage, { kind: "comment" })).not.toThrow();
    expect(() => assertRoleMayAct(triage, { kind: "label" })).toThrow(/may not perform "label"/);
  });

  test("guardrail gate (layer 2) catches gated actions independently of role set", () => {
    // assertRoleMayAct first checks role membership, THEN assertWithinGuardrails.
    // A gated kind like "merge-to-main" is never in any role's typed Guardrail[]
    // set, so the role layer rejects it first. But the guardrail layer is the
    // authoritative gate: verify it independently catches each gated kind.
    const gated: ProposedAction[] = [
      { kind: "merge-to-main" },
      { kind: "release" },
      { kind: "external-send" },
      { kind: "cross-repo" },
      { kind: "secret-rotate" },
      { kind: "secret-delete" },
    ];
    for (const action of gated) {
      expect(() => assertWithinGuardrails(action)).toThrow(GuardrailError);
    }
    // And assertRoleMayAct rejects a gated kind that passes the role's set
    // membership (here "comment" is in-set, but a misconfigured action payload
    // with kind "release" — not in any typed set — hits the role layer).
    const grooming = getRole("grooming");
    expect(() => assertRoleMayAct(grooming, { kind: "release" })).toThrow(
      /may not perform "release"/,
    );
  });
});

describe("scheduleRole — scheduled-routine harness", () => {
  test("fires the runner immediately on boot (backlog drain)", async () => {
    const role: RoleDescriptor = {
      name: "test-fire-role",
      cadence: "daily",
      intake: "poll-project",
      guardrails: ["comment"],
    };
    let calls = 0;
    const runner: RoleRunner = async () => {
      calls++;
      return { summary: "ran" };
    };
    const handle = scheduleRole(role, 60_000, runner, () => "tok");
    try {
      // First fire is immediate; await it via drain.
      await handle.drain(1000);
      expect(calls).toBeGreaterThanOrEqual(1);
      expect(handle.ran).toBe(true);
    } finally {
      handle.stop();
    }
  });

  test("re-fires on the interval (sequential, not overlapping)", async () => {
    const role = registerRole("test-interval-role", {
      cadence: "daily",
      intake: "poll-project",
      guardrails: ["comment"],
    });
    let calls = 0;
    const runner: RoleRunner = async () => {
      calls++;
      return { summary: `run ${calls}` };
    };
    // 50ms interval — short enough to observe 2+ fires quickly.
    const handle = scheduleRole(role, 50, runner, () => "tok");
    try {
      await handle.drain(200); // await the immediate first run
      // Wait long enough for at least one interval fire.
      await new Promise((r) => setTimeout(r, 140));
      expect(calls).toBeGreaterThanOrEqual(2);
    } finally {
      handle.stop();
    }
  });

  test("swallows runner errors (one bad run does not stop the cadence)", async () => {
    const role = registerRole("test-error-role", {
      cadence: "daily",
      intake: "poll-project",
      guardrails: ["comment"],
    });
    let calls = 0;
    const runner: RoleRunner = async () => {
      calls++;
      if (calls === 1) throw new Error("boom");
      return { summary: "recovered" };
    };
    const handle = scheduleRole(role, 30, runner, () => "tok");
    try {
      await handle.drain(500);
      await new Promise((r) => setTimeout(r, 80));
      // The first run threw but the cadence continued.
      expect(calls).toBeGreaterThanOrEqual(2);
    } finally {
      handle.stop();
    }
  });

  test("stop() prevents further fires", async () => {
    const role = registerRole("test-stop-role", {
      cadence: "daily",
      intake: "poll-project",
      guardrails: ["comment"],
    });
    let calls = 0;
    const runner: RoleRunner = async () => {
      calls++;
      return { summary: "ran" };
    };
    const handle = scheduleRole(role, 30, runner, () => "tok");
    await handle.drain(500); // await the immediate first run
    const callsAfterFirst = calls;
    handle.stop();
    await new Promise((r) => setTimeout(r, 100));
    expect(calls).toBe(callsAfterFirst); // no further fires after stop()
  });

  test("passes the token provider's token to the runner", async () => {
    const role = registerRole("test-token-role", {
      cadence: "daily",
      intake: "poll-project",
      guardrails: ["comment"],
    });
    let seen = "";
    const runner: RoleRunner = async (token) => {
      seen = token;
      return { summary: "ran" };
    };
    const handle = scheduleRole(role, 60_000, runner, () => "app-actor-token-xyz");
    try {
      await handle.drain(1000);
      expect(seen).toBe("app-actor-token-xyz");
    } finally {
      handle.stop();
    }
  });
});

/**
 * SIGTERM subprocess test mirroring operator.test.ts's pattern. Boots the
 * `test/fixtures/role-sigterm.ts` fixture (a scheduler with a SIGTERM handler
 * that calls handle.stop() + drain()), and verifies: the fixture becomes
 * ready, SIGTERM → exit 0, no further role fires after stop() (marker file
 * stops growing). The marker path is passed via env, like operator-sigterm.
 */
describe("scheduler SIGTERM subprocess (graceful stop + drain)", () => {
  test(
    "SIGTERM → scheduler stops, no further fires, process exits 0",
    async () => {
      const markerDir = mkdtempSync(join(tmpdir(), "linearctl-role-sigterm-"));
      const marker = join(markerDir, "calls.txt");
      const fixturePath = join(import.meta.dir, "fixtures", "role-sigterm.ts");

      const child = spawn("bun", ["run", fixturePath], {
        cwd: "/tmp/linearctl-track1",
        env: { ...process.env, ROLE_SIGTERM_MARKER: marker },
        stdio: ["ignore", "pipe", "pipe"],
      });

      try {
        // Wait for "fixture: scheduled".
        const ready = await new Promise<boolean>((resolve) => {
          const to = setTimeout(() => resolve(false), 10_000);
          child.stderr.on("data", (c: Buffer) => {
            if (c.toString().includes("fixture: scheduled")) {
              clearTimeout(to);
              resolve(true);
            }
          });
        });
        expect(ready).toBe(true);
        // Let it fire a few times.
        await new Promise((r) => setTimeout(r, 120));
        const callsBefore = existsSync(marker) ? await readFile(marker) : "";
        // Send SIGTERM — graceful stop + drain + exit 0.
        child.kill("SIGTERM");
        const code = await new Promise<number | null>((resolve) => {
          child.on("exit", (c) => resolve(c));
          setTimeout(() => resolve(null), 10_000);
        });
        expect(code).toBe(0);
        // After SIGTERM, wait and confirm no further appends.
        await new Promise((r) => setTimeout(r, 120));
        const callsAfter = existsSync(marker) ? await readFile(marker) : "";
        expect(callsAfter.length).toBe(callsBefore.length); // no growth after stop()
      } finally {
        if (child.exitCode === null) child.kill("SIGKILL");
      }
    },
    30_000,
  );
});

async function readFile(p: string): Promise<string> {
  const { readFile: rf } = await import("node:fs/promises");
  try {
    return await rf(p, "utf8");
  } catch {
    return "";
  }
}
