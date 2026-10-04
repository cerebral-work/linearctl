import example0 from "../../examples/whoami.sh" with { type: "text" };
import example1 from "../../examples/digest.sh" with { type: "text" };
import example2 from "../../examples/mine.sh" with { type: "text" };
import example3 from "../../examples/initiative.sh" with { type: "text" };
import example4 from "../../examples/file.sh" with { type: "text" };
import example5 from "../../examples/comment.sh" with { type: "text" };
import example6 from "../../examples/update.sh" with { type: "text" };
import example7 from "../../examples/close.sh" with { type: "text" };
import example8 from "../../examples/comments.sh" with { type: "text" };
import example9 from "../../examples/triage.sh" with { type: "text" };
import example10 from "../../examples/stale.sh" with { type: "text" };
import example11 from "../../examples/milestone.sh" with { type: "text" };
import example12 from "../../examples/project.sh" with { type: "text" };
import example13 from "../../examples/roadmap.sh" with { type: "text" };
import example14 from "../../examples/xref.sh" with { type: "text" };
import example15 from "../../examples/label.sh" with { type: "text" };
import example16 from "../../examples/park.sh" with { type: "text" };
import example17 from "../../examples/dupcheck.sh" with { type: "text" };
import example18 from "../../examples/search.sh" with { type: "text" };
import example19 from "../../examples/pull.sh" with { type: "text" };
import example20 from "../../examples/show.sh" with { type: "text" };
import example21 from "../../examples/standup.sh" with { type: "text" };
import example22 from "../../examples/release-notes.sh" with { type: "text" };
import example23 from "../../examples/cycle.sh" with { type: "text" };
import example24 from "../../examples/template.sh" with { type: "text" };
import example25 from "../../examples/link.sh" with { type: "text" };
import example26 from "../../examples/history.sh" with { type: "text" };
import example27 from "../../examples/doc.sh" with { type: "text" };
import example28 from "../../examples/handoff.sh" with { type: "text" };
import example29 from "../../examples/ratelimit.sh" with { type: "text" };
import example30 from "../../examples/loops.sh" with { type: "text" };
import example31 from "../../examples/mcp.sh" with { type: "text" };
import example32 from "../../examples/auth.sh" with { type: "text" };
import example33 from "../../examples/operator.sh" with { type: "text" };
import example34 from "../../examples/watch.sh" with { type: "text" };
import example35 from "../../examples/tui.sh" with { type: "text" };
import example36 from "../../examples/examples.sh" with { type: "text" };
import example37 from "../../examples/backup.sh" with { type: "text" };

/** Text imports are embedded by bun build --compile; no runtime filesystem dependency. */
export const EXAMPLES: Record<string, string> = {
  "whoami": example0,
  "digest": example1,
  "mine": example2,
  "initiative": example3,
  "file": example4,
  "comment": example5,
  "update": example6,
  "close": example7,
  "comments": example8,
  "triage": example9,
  "stale": example10,
  "milestone": example11,
  "project": example12,
  "roadmap": example13,
  "xref": example14,
  "label": example15,
  "park": example16,
  "dupcheck": example17,
  "search": example18,
  "pull": example19,
  "show": example20,
  "standup": example21,
  "release-notes": example22,
  "cycle": example23,
  "template": example24,
  "link": example25,
  "history": example26,
  "doc": example27,
  "handoff": example28,
  "ratelimit": example29,
  "loops": example30,
  "mcp": example31,
  "auth": example32,
  "operator": example33,
  "watch": example34,
  "tui": example35,
  "examples": example36,
  "backup": example37,
};

export function exampleHint(command: string): string {
  return EXAMPLES[command]?.match(/^# Example: (.+)$/m)?.[1] ?? "linearctl --help";
}
