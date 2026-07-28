/**
 * Reusable issue-table renderer for `linearctl tui` (CER-1550).
 *
 * Built from Ink `Box`/`Text` primitives — NOT `@inkjs/ui`, which is stale
 * (ADR-0008, `docs/features/tui.md:125-127`). Renders a columnar table of
 * `TriageItem` rows with a highlighted cursor. The same component will back all
 * list-style panes (Triage, Stale, Digest, Xref) as the dashboard grows.
 */

import { Box, Text } from "ink";
import type { TriageItem } from "../../core/grooming.js";

export interface IssueTableProps {
  /** Issues to render (already fetched from `core/*`). */
  items: TriageItem[];
  /** Index of the highlighted (cursor) row, or null/undefined for nothing. */
  cursor: number | null;
}

const COLUMN_WIDTHS = {
  marker: 2,
  identifier: 10,
  state: 12,
  assignee: 14,
  reasons: 24,
} as const;

function pad(value: string, width: number): string {
  if (value.length >= width) return value.slice(0, width);
  return value + " ".repeat(width - value.length);
}

function assigneeLabel(item: TriageItem): string {
  return item.assignee ?? "unassigned";
}

function reasonsLabel(item: TriageItem): string {
  return item.reasons.length > 0 ? item.reasons.join("+") : "—";
}

function HeaderRow(): React.ReactElement {
  return (
    <Box>
      <Box width={COLUMN_WIDTHS.marker}>
        <Text>{"  "}</Text>
      </Box>
      <Box width={COLUMN_WIDTHS.identifier}>
        <Text bold color="gray">
          {pad("Issue", COLUMN_WIDTHS.identifier)}
        </Text>
      </Box>
      <Box width={COLUMN_WIDTHS.state}>
        <Text bold color="gray">
          {pad("State", COLUMN_WIDTHS.state)}
        </Text>
      </Box>
      <Box width={COLUMN_WIDTHS.assignee}>
        <Text bold color="gray">
          {pad("Assignee", COLUMN_WIDTHS.assignee)}
        </Text>
      </Box>
      <Box width={COLUMN_WIDTHS.reasons}>
        <Text bold color="gray">
          {pad("Reasons", COLUMN_WIDTHS.reasons)}
        </Text>
      </Box>
      <Box flexGrow={1}>
        <Text bold color="gray">
          Title
        </Text>
      </Box>
    </Box>
  );
}

function IssueRow({
  item,
  highlighted,
}: {
  item: TriageItem;
  highlighted: boolean;
}): React.ReactElement {
  return (
    <Box>
      <Box width={COLUMN_WIDTHS.marker}>
        <Text color={highlighted ? "cyan" : undefined}>{highlighted ? "▸ " : "  "}</Text>
      </Box>
      <Box width={COLUMN_WIDTHS.identifier}>
        <Text color="cyan" bold={highlighted}>
          {pad(item.identifier, COLUMN_WIDTHS.identifier)}
        </Text>
      </Box>
      <Box width={COLUMN_WIDTHS.state}>
        <Text bold={highlighted}>{pad(item.state, COLUMN_WIDTHS.state)}</Text>
      </Box>
      <Box width={COLUMN_WIDTHS.assignee}>
        <Text color={item.assignee === null ? "gray" : undefined} bold={highlighted}>
          {pad(assigneeLabel(item), COLUMN_WIDTHS.assignee)}
        </Text>
      </Box>
      <Box width={COLUMN_WIDTHS.reasons}>
        <Text color="yellow" bold={highlighted}>
          {pad(reasonsLabel(item), COLUMN_WIDTHS.reasons)}
        </Text>
      </Box>
      <Box flexGrow={1}>
        <Text bold={highlighted}>{item.title}</Text>
      </Box>
    </Box>
  );
}

/**
 * Render a triage-issue table with a cursor indicator. An empty list renders a
 * placeholder message so the pane is never blank.
 */
export function IssueTable({ items, cursor }: IssueTableProps): React.ReactElement {
  if (items.length === 0) {
    return (
      <Box paddingX={1}>
        <Text color="green">No issues needing triage. Queue is empty.</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <HeaderRow />
      {items.map((item, index) => (
        <IssueRow key={item.identifier} item={item} highlighted={index === cursor} />
      ))}
    </Box>
  );
}
