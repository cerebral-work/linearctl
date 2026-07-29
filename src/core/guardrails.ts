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

/** A proposed role action. `kind` is checked against the guardrail sets. */
export interface ProposedAction {
  kind: string;
  /** Target issue ref (CER-123 or UUID), repo, or message — context for logs. */
  target?: string;
  /** Human-readable detail of what the role intends to do. */
  detail?: string;
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
}

/** True iff the kind is in the gated set (pure predicate, for tests/docs). */
export function isGated(kind: string): boolean {
  return GATED_KINDS.has(kind);
}
