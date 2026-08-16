/**
 * Guardrails — the D2 enforcement gate (CER-1188, Phase 3).
 *
 * The single checkpoint every role mutation passes through. Roles do NOT
 * implement their own gates — they propose actions via {@link ProposedAction},
 * and {@link assertWithinGuardrails} decides. The autonomous set is allowed;
 * the gated set (merge-to-main, cross-repo, external-send, release) throws.
 *
 * See `docs/agent-facility.md` §5. This is the *policy*; the role catalog
 * (`src/core/role-catalog.ts`) layers the *per-role permitted set* on top via
 * `assertRoleMayAct`.
 */

/** The autonomous action types a role may propose. */
export type Guardrail =
  | "comment" // additive comment on an issue
  | "label" // apply/remove a label (the stale dry-run-then-confirm contract)
  | "file-issue" // file an issue in the linearctl project (CER)
  | "update-issue" // state/priority/assignee/estimate within the linearctl team
  | "merge-own-green-pr"; // merge the agent's own green linearctl PR (squash, signed)

/** The gated set — these throw regardless of role, per D2. */
const GATED_KINDS: ReadonlySet<string> = new Set([
  "merge-to-main",
  "cross-repo",
  "external-send",
  "release",
  "secret-rotate",
  "secret-delete",
]);

/**
 * Deny labels — the multi-writer partition. An issue carrying any of these
 * labels is controlled by ANOTHER automated writer: `soma-ingest` marks the
 * WorkSource funnel's tickets (see docs/funnel-contract.md), and the funnel
 * keys its idempotency on `updatedAt` (funnel contract §1) — so even an
 * additive comment perturbs it. Such issues are read-only to this tool's
 * automated writers ENTIRELY.
 *
 * `LINEARCTL_DENY_LABELS` (comma-separated) EXTENDS the built-in set — it can
 * never remove `soma-ingest`. A partition that a deploy-values typo can
 * silently drop is not a partition; additions are config, removals are a code
 * change with review.
 */
const BUILTIN_DENY_LABELS = ["soma-ingest"] as const;

export function denyLabels(env: NodeJS.ProcessEnv = process.env): ReadonlySet<string> {
  const extra = (env.LINEARCTL_DENY_LABELS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return new Set([...BUILTIN_DENY_LABELS, ...extra]);
}

/** A proposed role action. `kind` is checked against the guardrail sets. */
export interface ProposedAction {
  kind: string;
  /** Target issue ref (CER-123 or UUID), repo, or message — context for logs. */
  target?: string;
  /** Human-readable detail of what the role intends to do. */
  detail?: string;
  /**
   * Labels on the target issue, when the action mutates one issue. When
   * provided, the checkpoint denies the action if any label is in the deny
   * set. Callers mutating an issue MUST provide this (fetched fresh or from
   * the sweep that selected the issue); batch paths partition with
   * {@link partitionDeniedTargets} instead.
   */
  targetLabels?: string[];
}

/**
 * Partition batch-mutation candidates into allowed vs denied by the deny-label
 * set. The batch counterpart of the `targetLabels` check — callers drop the
 * denied slice and MUST log it (no silent truncation).
 */
export function partitionDeniedTargets<T extends { labels: string[] }>(
  items: T[],
  env: NodeJS.ProcessEnv = process.env,
): { allowed: T[]; denied: T[] } {
  const deny = denyLabels(env);
  const allowed: T[] = [];
  const denied: T[] = [];
  for (const item of items) {
    (item.labels.some((l) => deny.has(l.trim().toLowerCase())) ? denied : allowed).push(item);
  }
  return { allowed, denied };
}

/** The boundary violation a guardrail check throws. */
export class GuardrailError extends Error {
  constructor(action: ProposedAction, reason: string) {
    super(`guardrail violation: ${reason} (kind="${action.kind}"${action.target ? `, target="${action.target}"` : ""})`);
    this.name = "GuardrailError";
  }
}

/**
 * The single D2 checkpoint. Throws {@link GuardrailError} if `action` is in
 * the gated set (merge-to-main, cross-repo, external-send, release, secret
 * mutate) — those NEVER run autonomously and require the operator.
 *
 * Non-gated kinds are allowed by this layer; the role catalog's
 * `assertRoleMayAct` further restricts them to the role's declared set.
 */
export function assertWithinGuardrails(action: ProposedAction): void {
  if (GATED_KINDS.has(action.kind)) {
    throw new GuardrailError(
      action,
      `"${action.kind}" is gated — requires operator approval (D2)`,
    );
  }
  if (action.targetLabels) {
    const deny = denyLabels();
    const hit = action.targetLabels.find((l) => deny.has(l.trim().toLowerCase()));
    if (hit !== undefined) {
      throw new GuardrailError(
        action,
        `target carries deny label "${hit}" — owned by another automated writer (multi-writer partition)`,
      );
    }
  }
}

/** True iff the kind is in the gated set (pure predicate, for tests/docs). */
export function isGated(kind: string): boolean {
  return GATED_KINDS.has(kind);
}
