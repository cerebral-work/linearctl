/**
 * Role catalog — the typed registry of maintainer-agent roles (CER-1188).
 *
 * Each role is a static descriptor: `{ name, cadence, intake, guardrails }`.
 * This encodes D1 (hybrid runtime: scheduled routines + coord-mesh standby)
 * and D4 (cadence: groom daily · featuredev weekly · sprint biweekly).
 *
 * No LLM dependency — the catalog is static config. The first slice registers
 * the two roles that ship without the LLM (intake-triage, grooming); later
 * phases add the rest. See `docs/agent-facility.md` §3 for the full table.
 */

import { assertWithinGuardrails, type Guardrail, type ProposedAction } from "./guardrails.js";

/** D4 cadence — how often a role's scheduled routine fires. */
export type Cadence = "daily" | "weekly" | "biweekly";

/** D1 intake — how a role receives work. */
export type Intake = "poll-project" | "coord-dispatch" | "both";

/** DAY_MS mirrors `src/core/grooming.ts` (86_400_000). */
export const DAY_MS = 86_400_000;

/** Map a D4 cadence to its interval in ms (the scheduler's tick). */
export function cadenceToMs(c: Cadence): number {
  switch (c) {
    case "daily":
      return DAY_MS;
    case "weekly":
      return 7 * DAY_MS;
    case "biweekly":
      return 14 * DAY_MS;
  }
}

/**
 * A role descriptor. `guardrails` is the subset of the autonomous set this role
 * is permitted to exercise. The single enforcement point
 * (`assertWithinGuardrails`) consults the role's guardrail set; a role cannot
 * widen its own set.
 */
export interface RoleDescriptor {
  /** Stable identifier, e.g. `"intake-triage"`. Matches `--role <name>`. */
  name: string;
  /** D4 cadence — drives the scheduler interval. */
  cadence: Cadence;
  /** D1 intake — poll-project (default phases 0–3) / coord-dispatch / both. */
  intake: Intake;
  /**
   * The autonomous action types this role may perform. The guardrail checkpoint
   * throws if a proposed action type is not in this set OR is in the gated set
   * (merge-to-main, cross-repo, external-send, release) regardless of role.
   */
  guardrails: Guardrail[];
}

/** A role handler — the scheduled routine itself. Injected by the scheduler. */
export type RoleRunner = (token: string) => Promise<RoleRunResult>;

/** What a role run produced: a summary + any proposed mutation to gate. */
export interface RoleRunResult {
  /** Human/Markdown summary of what the role observed (logged / posted). */
  summary: string;
  /** Proposed action to gate via `assertWithinGuardrails` before applying. */
  proposed?: ProposedAction;
  /** The Linear issue ref to post the summary as a comment on (optional). */
  commentOn?: string;
}

const registry = new Map<string, RoleDescriptor>();

/**
 * Register a role. Idempotent: re-registering the same name overwrites (so the
 * operator can boot with a `--role` set that re-declares a role's guardrails).
 */
export function registerRole(name: string, descriptor: Omit<RoleDescriptor, "name">): RoleDescriptor {
  const full: RoleDescriptor = { name, ...descriptor };
  registry.set(name, full);
  return full;
}

/** Look up a role by name. Throws if unregistered (a `--role` typo). */
export function getRole(name: string): RoleDescriptor {
  const role = registry.get(name);
  if (!role) {
    const known = registry.size ? [...registry.keys()].join(", ") : "(none registered)";
    throw new Error(`unknown role "${name}" — registered: ${known}`);
  }
  return role;
}

/** List all registered role names. */
export function listRoles(): string[] {
  return [...registry.keys()];
}

/**
 * The D2 checkpoint wrapper a role uses before applying a mutation. Combines
 * the single guardrail gate (`assertWithinGuardrails`) with the role's own
 * permitted-set: a role cannot act outside its declared set even if the action
 * is otherwise autonomous.
 *
 * (`roleAllows` is inlined here — it has a single caller and adds no behavior
 * beyond `guardrails.includes(kind)`.)
 */
export function assertRoleMayAct(role: RoleDescriptor, action: ProposedAction): void {
  // `kind` is a runtime string (a role can propose any kind); the guardrail set
  // is a fixed Guardrail[] on the descriptor. Cast leftward: membership of a
  // dynamic string against a literal-union array is the intended check.
  if (!(role.guardrails as readonly string[]).includes(action.kind)) {
    throw new Error(
      `role "${role.name}" may not perform "${action.kind}" — not in its guardrail set`,
    );
  }
  assertWithinGuardrails(action);
}

// --- First-slice static registrations (phases 0–3) ---

/** intake-triage: daily, poll-project, read + comment only (no mutations). */
registerRole("intake-triage", {
  cadence: "daily",
  intake: "poll-project",
  guardrails: ["comment"],
});

/** grooming: daily, poll-project, autonomous stale-label + comment. */
registerRole("grooming", {
  cadence: "daily",
  intake: "poll-project",
  guardrails: ["comment", "label"],
});
