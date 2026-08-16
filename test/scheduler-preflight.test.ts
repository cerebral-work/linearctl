import { describe, expect, test } from "bun:test";
import { scheduleRole, type Preflight } from "../src/core/scheduler.js";
import { getRole, type RoleRunResult } from "../src/core/role-catalog.js";

const role = () => getRole("intake-triage");
const tick = () => new Promise((r) => setTimeout(r, 20));

describe("scheduler preflight (OPS-1214)", () => {
  test("skip verdict prevents the run and keeps the cadence armed", async () => {
    let runs = 0;
    const runner = async (): Promise<RoleRunResult> => {
      runs += 1;
      return { summary: "ran" };
    };
    const preflight: Preflight = async () => ({ skip: true, reason: "HOLD engaged (test)" });
    const handle = scheduleRole(role(), 60_000, runner, () => "tok", preflight);
    await tick();
    expect(runs).toBe(0);
    expect(handle.ran).toBe(false);
    handle.stop();
    await handle.drain();
  });

  test("pass verdict lets the run fire", async () => {
    let runs = 0;
    const runner = async (): Promise<RoleRunResult> => {
      runs += 1;
      return { summary: "ran" };
    };
    const preflight: Preflight = async () => ({ skip: false });
    const handle = scheduleRole(role(), 60_000, runner, () => "tok", preflight);
    await tick();
    expect(runs).toBe(1);
    expect(handle.ran).toBe(true);
    handle.stop();
    await handle.drain();
  });

  test("a throwing preflight proceeds (fail-open) rather than stopping the cadence", async () => {
    let runs = 0;
    const runner = async (): Promise<RoleRunResult> => {
      runs += 1;
      return { summary: "ran" };
    };
    const preflight: Preflight = async () => {
      throw new Error("probe unreachable");
    };
    const handle = scheduleRole(role(), 60_000, runner, () => "tok", preflight);
    await tick();
    expect(runs).toBe(1);
    handle.stop();
    await handle.drain();
  });
});
