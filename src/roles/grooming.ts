/**
 * `grooming` role handler (CER-1188, Phase 3).
 *
 * Daily cadence (D4). Reuses `core/grooming.ts` fully — labels stale issues
 * via the existing dry-run-then-confirm contract from `src/commands/stale.ts`
 * (`applyStaleLabel(items, label, apply)`). This is the first role that
 * *mutates*, so the D2 guardrail checkpoint (`assertRoleMayAct`) is exercised
 * on every run: the proposed `label` action is gated before applying.
 *
 * D2 boundary: auto-file/groom is autonomous, but NEVER release, touch other
 * repos/teams, or send externally (PUNCH-LIST:127). Enforced by the single
 * checkpoint in `src/core/guardrails.ts` — roles don't implement their own gates.
 *
 * See `docs/agent-facility.md` §5 (guardrails).
 */

import { makeOAuthClient } from "../client.js";
import { stale as getStale, applyStaleLabel } from "../core/grooming.js";
import { getRole, assertRoleMayAct } from "../core/role-catalog.js";
import type { RoleRunResult } from "../core/role-catalog.js";
import { partitionDeniedTargets } from "../core/guardrails.js";
import { MutationBudget } from "../core/containment.js";
import { sinceToDate } from "../lib/time.js";

const DEFAULT_TEAM = process.env.LINEARCTL_AGENT_TEAM ?? "CER";
const DEFAULT_PROJECT = process.env.LINEARCTL_AGENT_PROJECT;
const DEFAULT_STALE_WARN = process.env.LINEARCTL_AGENT_STALE_WARN ?? "30d";
const STALE_LABEL = process.env.LINEARCTL_AGENT_STALE_LABEL ?? "stale";
/**
 * Apply the label (the mutating half of the dry-run-then-confirm contract).
 * Default false — dry-run preview only (the `CLAUDE.md` honesty rule). Set
 * `LINEARCTL_AGENT_STALE_APPLY=1` to actually relabel issues autonomously.
 */
const APPLY = process.env.LINEARCTL_AGENT_STALE_APPLY === "1";

/**
 * The grooming role handler. Sweeps stale issues, gates the proposed label
 * mutation through `assertRoleMayAct` (the D2 checkpoint), then applies (or
 * dry-runs) the `stale` label. Returns a summary; the scheduler logs it.
 */
export async function runGrooming(token: string): Promise<RoleRunResult> {
  const client = makeOAuthClient(token);
  const now = new Date();
  const warnCutoff = sinceToDate(DEFAULT_STALE_WARN, now);
  const ninetyCutoff = sinceToDate("90d", now);
  const criticalCutoff = warnCutoff < ninetyCutoff ? warnCutoff : ninetyCutoff;

  const result = await getStale(client, {
    teamKeys: [DEFAULT_TEAM],
    project: DEFAULT_PROJECT,
    warnCutoff,
    criticalCutoff,
    now,
  });

  if (result.items.length === 0) {
    return { summary: `grooming: no stale issues (>${DEFAULT_STALE_WARN} warn threshold)` };
  }

  // Dual-writer partition (§2b2): issues carrying a deny label (soma-ingest)
  // belong to another automated writer — read-only here, dropped LOUDLY.
  const { allowed, denied } = partitionDeniedTargets(result.items);
  if (denied.length) {
    console.error(
      `role[grooming]: ${denied.length} issue(s) skipped — deny-labeled (other writer): ` +
        denied.slice(0, 8).map((i) => i.identifier).join(", ") +
        (denied.length > 8 ? ", …" : ""),
    );
  }
  if (allowed.length === 0) {
    return { summary: `grooming: ${result.items.length} stale issue(s), all deny-labeled — nothing to do` };
  }

  // Mutation budget (OPS-1214): cap writes per run; truncation is narrated,
  // never silent. Dry-run previews the same capped slice the apply would take,
  // so the log tells the truth about what an apply run WOULD do.
  const budget = new MutationBudget();
  const granted = APPLY ? budget.trySpend(allowed.length) : Math.min(allowed.length, budget.total);
  const batch = allowed.slice(0, granted);
  if (granted < allowed.length) {
    console.error(
      `role[grooming]: mutation budget ${budget.total}/run — ` +
        `${allowed.length - granted} of ${allowed.length} candidate(s) deferred to a later run`,
    );
  }
  if (batch.length === 0) {
    return { summary: `grooming: mutation budget exhausted — 0 of ${allowed.length} candidate(s) processed` };
  }

  // Single D2 checkpoint — the role asserts its own label action BEFORE applying.
  // The role's guardrail set is ["comment", "label"]; this is in-set, so it
  // proceeds unless the gated set (merge/release/external) blocks it (it won't
  // for "label", but the gate is the policy that would catch a misconfigured role).
  const role = getRole("grooming");
  const proposed = { kind: "label" as const, target: STALE_LABEL, detail: `apply to ${batch.length} stale issue(s)` };
  assertRoleMayAct(role, proposed);

  const labelResult = await applyStaleLabel(client, batch, STALE_LABEL, APPLY);

  const summary = formatGrooming(
    result.warn,
    result.critical,
    labelResult.applied,
    labelResult.count,
    labelResult.identifiers,
  );
  return { summary, proposed };
}

/** Render the grooming result as a one-line summary for the scheduler log. */
function formatGrooming(
  warnCount: number,
  criticalCount: number,
  applied: boolean,
  count: number,
  identifiers: string[],
): string {
  const verb = applied ? "labeled" : "[dry-run] would label";
  const head = `grooming: ${warnCount} warn · ${criticalCount} critical stale`;
  const tail = `${verb} ${count} issue(s) with "stale"`;
  const refs = identifiers.slice(0, 8).join(", ") + (identifiers.length > 8 ? ", …" : "");
  return `${head}; ${tail}: ${refs}`;
}
