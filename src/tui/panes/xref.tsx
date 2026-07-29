/**
 * Xref pane for `linearctl tui` (CER-1550).
 *
 * Presents the pre-fetched result from `core/xref.xref()` — the same result
 * used by `linearctl xref`. The pane is presentation-only: it groups drift by
 * the core finding categories and never talks to Linear or GitHub directly.
 */

import { Box, Text, useApp, useInput } from "ink";
import { useEffect, useState } from "react";
import type { XrefFinding, XrefResult } from "../../core/xref.js";

export interface XrefPaneProps {
  /** Pre-fetched reconciliation result (the app fetches before mounting). */
  result: XrefResult;
}

type FindingKind = XrefFinding["kind"];

const CATEGORIES: ReadonlyArray<{
  kind: FindingKind;
  label: string;
  color: "yellow" | "red" | "magenta";
}> = [
  { kind: "open-pr-no-ticket", label: "Open PR · no ticket", color: "yellow" },
  { kind: "merged-pr-no-ticket", label: "Merged PR · no ticket", color: "red" },
  { kind: "merged-pr-ticket-not-done", label: "Merged PR · ticket not Done", color: "yellow" },
  { kind: "pr-ref-missing-ticket", label: "PR ref · missing ticket", color: "magenta" },
];

const COLUMN_WIDTHS = {
  marker: 2,
  pr: 8,
  refs: 18,
} as const;

function pad(value: string, width: number): string {
  if (value.length >= width) return value.slice(0, width);
  return value + " ".repeat(width - value.length);
}

function FindingRow({
  finding,
  highlighted,
}: {
  finding: XrefFinding;
  highlighted: boolean;
}): React.ReactElement {
  const refs = finding.refs.length > 0 ? finding.refs.join(",") : "—";

  return (
    <Box>
      <Box width={COLUMN_WIDTHS.marker}>
        <Text color={highlighted ? "cyan" : undefined}>{highlighted ? "▸ " : "  "}</Text>
      </Box>
      <Box width={COLUMN_WIDTHS.pr}>
        <Text color="cyan" bold={highlighted}>
          {pad(`#${finding.pr}`, COLUMN_WIDTHS.pr)}
        </Text>
      </Box>
      <Box width={COLUMN_WIDTHS.refs}>
        <Text color={finding.refs.length > 0 ? undefined : "gray"} bold={highlighted}>
          {pad(refs, COLUMN_WIDTHS.refs)}
        </Text>
      </Box>
      <Box flexGrow={1}>
        <Text bold={highlighted}>{finding.detail}</Text>
      </Box>
    </Box>
  );
}

/**
 * The Xref pane. Holds cursor state, renders the reconciliation summary and
 * grouped drift findings, and handles `j`/`k` navigation + `q` quit locally.
 */
export function XrefPane({ result }: XrefPaneProps): React.ReactElement {
  const { exit } = useApp();
  const [cursor, setCursor] = useState<number>(0);

  const grouped = CATEGORIES.map((category) => ({
    ...category,
    findings: result.findings.filter((finding) => finding.kind === category.kind),
  }));
  const orderedFindings = grouped.flatMap((category) => category.findings);

  // Clamp cursor if a refreshed reconciliation result contains fewer findings.
  useEffect(() => {
    setCursor((current) => Math.min(current, Math.max(0, orderedFindings.length - 1)));
  }, [orderedFindings.length]);

  useInput((input, key) => {
    if (orderedFindings.length === 0) {
      if (input === "q") exit();
      return;
    }

    if (input === "j" || key.downArrow) {
      setCursor((current) => Math.min(current + 1, orderedFindings.length - 1));
      return;
    }

    if (input === "k" || key.upArrow) {
      setCursor((current) => Math.max(current - 1, 0));
      return;
    }

    if (input === "q") {
      exit();
    }
  });

  const unmatchedPRs = new Set(
    result.findings
      .filter(
        (finding) =>
          finding.kind === "open-pr-no-ticket" || finding.kind === "merged-pr-no-ticket",
      )
      .map((finding) => finding.pr),
  ).size;
  const matchedPRs = Math.max(0, result.openPRs + result.mergedPRs - unmatchedPRs);
  let rowIndex = 0;

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text bold>
          PR↔ticket xref <Text color="gray">({result.repo})</Text>
        </Text>
      </Box>
      <Box marginBottom={1}>
        <Text color="green">Matched {matchedPRs}</Text>
        <Text color="gray">
          {" · "}{result.openPRs} open · {result.mergedPRs} merged · {result.findings.length}{" "}
          {result.findings.length === 1 ? "finding" : "findings"}
        </Text>
      </Box>

      {result.findings.length === 0 ? (
        <Box paddingX={1}>
          <Text color="green">No PR↔ticket drift found.</Text>
        </Box>
      ) : (
        grouped.map((category) => {
          if (category.findings.length === 0) return null;
          return (
            <Box key={category.kind} flexDirection="column" marginBottom={1}>
              <Text bold color={category.color}>
                {category.label} ({category.findings.length})
              </Text>
              {category.findings.map((finding) => {
                const index = rowIndex++;
                return (
                  <FindingRow
                    key={`${finding.kind}-${finding.pr}-${finding.refs.join(",")}`}
                    finding={finding}
                    highlighted={index === cursor}
                  />
                );
              })}
            </Box>
          );
        })
      )}

      <Box marginTop={1}>
        <Text color="gray">j/k move · q quit</Text>
      </Box>
    </Box>
  );
}
