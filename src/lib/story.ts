/**
 * User-story description scaffold for `park` (docs/features/park.md). Pure.
 * Emits only the parts the caller supplied — no invented prose.
 */
export interface StoryParts {
  title: string;
  persona?: string;
  want?: string;
  why?: string;
  acceptance?: string[];
}

export function buildStoryDescription(parts: StoryParts): string | undefined {
  const accept = (parts.acceptance ?? []).map((l) => l.trim()).filter(Boolean);
  if (!parts.persona && !parts.why && !parts.want && accept.length === 0) {
    return undefined;
  }
  const lines: string[] = [];
  if (parts.persona || parts.want || parts.why) {
    lines.push(`As a ${parts.persona ?? "user"},`);
    lines.push(`I want ${parts.want ?? parts.title}${parts.why ? "," : "."}`);
    if (parts.why) lines.push(`so that ${parts.why}.`);
  }
  if (accept.length) {
    if (lines.length) lines.push("");
    lines.push("## Acceptance criteria");
    for (const a of accept) lines.push(`- ${a}`);
  }
  return lines.join("\n");
}
