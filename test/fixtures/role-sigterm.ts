/**
 * Test fixture for the scheduler SIGTERM subprocess test (CER-1188 / Track 1).
 *
 * Boots a role scheduler with a SIGTERM handler that calls handle.stop() +
 * drain(), then blocks. The parent test spawns this via `bun run`, waits for
 * the "fixture: scheduled" marker, sends SIGTERM, and asserts: exit 0 + no
 * further role fires after stop() (marker file stops growing).
 *
 * The marker path is passed via `ROLE_SIGTERM_MARKER` env so the test controls
 * the temp dir. Mirrors `test/fixtures/operator-sigterm.ts` (CER-1149).
 */
import { appendFileSync } from "node:fs";
import { registerRole, getRole } from "../../src/core/role-catalog.js";
import { scheduleRole } from "../../src/core/scheduler.js";

const marker = process.env.ROLE_SIGTERM_MARKER;
if (!marker) {
  console.error("ROLE_SIGTERM_MARKER env required");
  process.exit(2);
}

registerRole("sigterm-test", {
  cadence: "daily",
  intake: "poll-project",
  guardrails: ["comment"],
});
const role = getRole("sigterm-test");
const handle = scheduleRole(
  role,
  30,
  async () => {
    appendFileSync(marker, "x");
    return { summary: "ran" };
  },
  () => "tok",
);

process.stderr.write("fixture: scheduled\n");
process.once("SIGTERM", () => {
  handle.stop();
  void handle.drain(500).then(() => process.exit(0));
});
// Block until the signal handler calls process.exit(0).
await new Promise(() => {});
