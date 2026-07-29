/**
 * Stale pane for `linearctl tui` (CER-1550).
 *
 * Pure presentation for the pre-fetched result from `core/grooming.stale()` —
 * the same function used by `linearctl stale`. Issues are split into critical
 * and warning age buckets, with one cursor spanning both sections.
 */

import { Box, Text, useApp, useInput } from "ink";
import { useEffect, useMemo, useState } from "react";
import type { StaleItem, StaleResult } from "../../core/grooming.js";

export interface StalePaneProps {
  /** Pre-fetched stale result (the app fetches before mounting the pane). */
  result: StaleResult;
}

const COLUMN_WIDTHS = {
  marker: 2,
  identifier: 10,
  days: 9,
  state: 14,
  assignee: 16,
} as const;

function pad(value: string, width: number): string {
  if (value.length >= width) return value.slice(0, width);
  return value + " ".repeat(width - value.length);
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
      <Box width={COLUMN_WIDTHS.days}>
        <Text bold color="gray">
          {pad("Age", COLUMN_WIDTHS.days)}
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
  item: StaleItem;
  highlighted: boolean;
}): React.ReactElement {
  const bucketColor = item.bucket === "critical" ? "red" : "yellow";

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
      <Box width={COLUMN_WIDTHS.days}>
        <Text color={bucketColor} bold={highlighted}>
          {pad(`${item.daysStale}d`, COLUMN_WIDTHS.days)}
        </Text>
      </Box>
      <Box width={COLUMN_WIDTHS.state}>
        <Text bold={highlighted}>{pad(item.state, COLUMN_WIDTHS.state)}</Text>
      </Box>
      <Box width={COLUMN_WIDTHS.assignee}>
        <Text color={item.assignee === null ? "gray" : undefined} bold={highlighted}>
          {pad(item.assignee ?? "unassigned", COLUMN_WIDTHS.assignee)}
        </Text>
      </Box>
      <Box flexGrow={1}>
        <Text bold={highlighted}>{item.title}</Text>
      </Box>
    </Box>
  );
}

function Bucket({
  label,
  color,
  items,
  cursor,
  offset,
}: {
  label: string;
  color: "red" | "yellow";
  items: StaleItem[];
  cursor: number;
  offset: number;
}): React.ReactElement | null {
  if (items.length === 0) return null;

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text bold color={color}>
        {label} ({items.length})
      </Text>
      <HeaderRow />
      {items.map((item, index) => (
        <IssueRow
          key={item.id}
          item={item}
          highlighted={offset + index === cursor}
        />
      ))}
    </Box>
  );
}

/** Render stale issues by age bucket with `j`/`k` navigation and `q` quit. */
export function StalePane({ result }: StalePaneProps): React.ReactElement {
  const { exit } = useApp();
  const [cursor, setCursor] = useState<number>(0);
  const criticalItems = useMemo(
    () => result.items.filter((item) => item.bucket === "critical"),
    [result.items],
  );
  const warnItems = useMemo(
    () => result.items.filter((item) => item.bucket === "warn"),
    [result.items],
  );
  const count = criticalItems.length + warnItems.length;

  // Clamp cursor if the item list shrinks below it.
  useEffect(() => {
    setCursor((current) => Math.min(current, Math.max(0, count - 1)));
  }, [count]);

  useInput((input, key) => {
    if (count === 0) {
      if (input === "q") exit();
      return;
    }

    if (input === "j" || key.downArrow) {
      setCursor((current) => Math.min(current + 1, count - 1));
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

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text bold>
          Stale issues{" "}
          <Text color="gray">
            ({count} {count === 1 ? "issue" : "issues"})
          </Text>
        </Text>
      </Box>
      {count === 0 ? (
        <Box paddingX={1}>
          <Text color="green">No stale issues. Queue is empty.</Text>
        </Box>
      ) : (
        <>
          <Bucket
            label={`Critical · older than ${result.criticalDays}d`}
            color="red"
            items={criticalItems}
            cursor={cursor}
            offset={0}
          />
          <Bucket
            label={`Warn · older than ${result.olderThanDays}d`}
            color="yellow"
            items={warnItems}
            cursor={cursor}
            offset={criticalItems.length}
          />
        </>
      )}
      <Box marginTop={1}>
        <Text color="gray">j/k move · Enter detail · q quit</Text>
      </Box>
    </Box>
  );
}
