/**
 * `intake-triage` role handler (CER-1188, Phase 2).
 *
 * The first role — read-heavy, low-autonomy, exercises the full D1/D3 contracts
 * without needing the LLM. Polls the linearctl Linear project (CER) via the
 * existing `core/grooming.ts` triage + stale functions, summarizes new
 * unassigned / unestimated / no-priority issues, and (optionally) posts the
 * summary as a comment on a tracking issue.
 *
 * Daily cadence (D4). Read + comment only — no mutations beyond an additive
 * comment, which the role's guardrail set (`["comment"]`) permits.
 *
 * See `docs/agent-facility.md` §3 (catalog) + §6 (intake).
 */

import { makeOAuthClient } from "../client.js";
import { triage as getTriageQueue, stale as getStale } from "../core/grooming.js";
import { createComment } from "../core/issues.js";
import { getRole, assertRoleMayAct } from "../core/role-catalog.js";
import { MutationBudget } from "../core/containment.js";
import { withRetry } from "../lib/retry.js";
import { sinceToDate } from "../lib/time.js";
import type { RoleRunResult } from "../core/role-catalog.js";

/** The default team + stale window — overridable via env for tests/ops. */
const DEFAULT_TEAM = process.env.LINEARCTL_AGENT_TEAM ?? "CER";
const DEFAULT_PROJECT = process.env.LINEARCTL_AGENT_PROJECT;
const DEFAULT_STALE_WARN = process.env.LINEARCTL_AGENT_STALE_WARN ?? "30d";

/**
 * Optional issue ref (CER-NNN / UUID) the role posts its summary comment on.
 * When unset, the role emits the summary only (logged by the scheduler) — no
 * mutation. This is the safe default: a read-only triage pass.
 */
const COMMENT_TARGET = process.env.LINEARCTL_INTAKE_TRIAGE_TARGET;

/**
 * The intake-triage role handler. Returns a {@link RoleRunResult}; the scheduler
 * logs the summary. If `LINEARCTL_INTAKE_TRIAGE_TARGET` is set, the role posts
 * the summary as a comment (additive, non-destructive) — gated by the role's
 * `"comment"` guardrail before the `createComment` call.
 */
export async function runIntakeTriage(token: string): Promise<RoleRunResult> {
  const client = makeOAuthClient(token);
  const now = new Date();
  const warnCutoff = sinceToDate(DEFAULT_STALE_WARN, now);
  const ninetyCutoff = sinceToDate("90d", now);
  const criticalCutoff = warnCutoff < ninetyCutoff ? warnCutoff : ninetyCutoff;

  const [triageItems, staleResult] = await Promise.all([
    getTriageQueue(client, [DEFAULT_TEAM], DEFAULT_PROJECT),
    getStale(client, {
      teamKeys: [DEFAULT_TEAM],
      project: DEFAULT_PROJECT,
      warnCutoff,
      criticalCutoff,
      now,
    }),
  ]);

  const summary = formatSummary(triageItems, staleResult.warn, staleResult.critical);

  if (COMMENT_TARGET) {
    // Additive comment — permitted by the role's guardrail set. The role
    // asserts itself before the mutation (single checkpoint:
    // src/core/guardrails.ts), passing the target's LIVE labels so the
    // multi-writer deny rule can refuse a deny-labeled target (the funnel
    // keys idempotency on updatedAt — funnel contract §1 — so even an
    // additive comment perturbs it).
    //
    // The comment is the OPTIONAL half of this role; the read-only summary is
    // the point. A refused/failed comment (budget zero, denied target, fetch
    // error) degrades to summary-only with a note — it must never turn a
    // read-only triage pass into a permanently failing run.
    try {
      if (new MutationBudget().trySpend(1) === 0) {
        console.error("role[intake-triage]: mutation budget is 0 — summary-only (comment skipped)");
      } else {
        const issue = await withRetry(() => client.issue(COMMENT_TARGET));
        const labels = await withRetry(() => issue.labels());
        assertRoleMayAct(getRole("intake-triage"), {
          kind: "comment",
          target: COMMENT_TARGET,
          detail: "post intake-triage summary",
          targetLabels: labels.nodes.map((l) => l.name),
        });
        await createComment(client, COMMENT_TARGET, summary);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`role[intake-triage]: comment on ${COMMENT_TARGET} skipped — ${msg}`);
    }
  }

  // `proposed` is undefined: this slice posts the comment inline (above) when a
  // target is set, rather than deferring to the scheduler. The guardrail gate
  // (`assertRoleMayAct`) is exercised by the grooming role's label mutation.
  return {
    summary,
    commentOn: COMMENT_TARGET,
  };
}

/** Escape a bounded title for one Markdown-table cell. */
export function escapeTableCell(title: string): string {
  // Bound the source first so truncation cannot cut an inserted escape pair.
  // Escape backslashes before pipes: `\|` must become `\\\|`, not remain a
  // backslash that neutralizes our pipe escape (CodeQL js/incomplete-sanitization).
  return title.slice(0, 80).replace(/\\/g, "\\\\").replace(/\|/g, "\\|");
}

/** Render the triage + stale summary as Markdown. */
function formatSummary(
  triageItems: Array<{ identifier: string; title: string; reasons: string[]; url: string }>,
  warnCount: number,
  criticalCount: number,
): string {
  const lines: string[] = [
    "### intake-triage summary",
    "",
    `**Triage queue:** ${triageItems.length} issue(s) needing attention`,
    `**Stale:** ${warnCount} warn · ${criticalCount} critical`,
    "",
  ];
  if (triageItems.length === 0) {
    lines.push("_No issues need triage._");
    return lines.join("\n");
  }
  lines.push("| Issue | Reasons | Title |", "|---|---|---|");
  for (const item of triageItems.slice(0, 20)) {
    const title = escapeTableCell(item.title);
    lines.push(`| [${item.identifier}](${item.url}) | ${item.reasons.join(", ")} | ${title} |`);
  }
  if (triageItems.length > 20) {
    lines.push(`| … | _${triageItems.length - 20} more_ | |`);
  }
  return lines.join("\n");
}
