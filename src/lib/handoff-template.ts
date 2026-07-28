/**
 * The markdown body skeleton for a new handoff. Matches the section structure
 * of the existing human-authored handoff at
 * `docs/handoffs/2026-07-28-cer-1148-oauth-scaffolding.md`:
 *
 *   ## What landed
 *   ## Verification
 *   ## Decisions
 *   ## Next steps
 *
 * The frontmatter (id/date/title/pr/ticket/status) is owned by
 * `core/handoffs.ts#serializeHandoff`; this module only shapes the body a
 * caller fills in when `--body` is omitted (the `create` command drops the
 * caller into the skeleton) and gives `validateHandoffBody` something to check
 * a handoff against. Kept as a function, not a constant, so a future `--template`
 * flag can parameterize section headings without a second convention.
 */

/** The ordered section headings a handoff body should carry. */
export const HANDOFF_SECTIONS = [
  "## What landed",
  "## Verification",
  "## Decisions",
  "## Next steps",
] as const;

/**
 * Emit the handoff body skeleton: each section heading followed by a blank
 * line + a placeholder prompt the author replaces. Returns markdown meant to
 * be the `body` passed to `core/handoffs.createHandoff` (frontmatter is added
 * separately by `serializeHandoff`).
 */
export function handoffBodySkeleton(opts: {
  pr?: string;
  ticket?: string;
} = {}): string {
  const lines: string[] = [];
  lines.push("## What landed", "");
  lines.push("<!-- one-line summary of what shipped; frontmatter holds pr/ticket -->", "");
  if (opts.pr || opts.ticket) {
    const refs = [opts.ticket, opts.pr].filter(Boolean).join(" / ");
    lines.push(`ref: ${refs}`, "");
  }
  lines.push("## Verification", "");
  lines.push("- [ ] `bun run typecheck` clean", "");
  lines.push("- [ ] `bun test` passes (N before → N+M after)", "");
  lines.push("- [ ] `bun build` + `linearctl <verb> --help` run", "");
  lines.push("## Decisions", "");
  lines.push("<!-- operator decisions made this session, with rationale -->", "");
  lines.push("## Next steps", "");
  lines.push("<!-- what the next session should do first -->", "");
  return lines.join("\n") + "\n";
}

/**
 * Report which required sections are missing from a handoff body. Returns the
 * list of missing headings (empty = body is structurally complete). This is a
 * structural check, not a content check — a section present but empty still
 * passes; the author owns the prose.
 */
export function missingSections(body: string): string[] {
  return HANDOFF_SECTIONS.filter((h) => !body.includes(h));
}
