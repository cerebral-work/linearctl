/**
 * Digest pane for `linearctl tui` (CER-1550).
 *
 * Pure presentation over a pre-fetched `core/grooming.digest()` result. Recent
 * issues remain grouped in the workflow-state order supplied by the core, while
 * one cursor moves across every issue with `j`/`k` navigation.
 */

import { Box, Text, useApp, useInput } from "ink";
import { useEffect, useMemo, useState } from "react";
import type { DigestItem, DigestResult } from "../../core/grooming.js";

export interface DigestPaneProps {
  /** Pre-fetched digest result (the app fetches before mounting the pane). */
  result: DigestResult;
}

const COLUMN_WIDTHS = {
  marker: 2,
  identifier: 10,
  state: 16,
  assignee: 16,
} as const;

function pad(value: string, width: number): string {
  if (value.length >= width) return value.slice(0, width);
  return value + " ".repeat(width - value.length);
}

function groupLabel(type: string): string {
  return type.length === 0 ? "Unknown" : type[0]!.toUpperCase() + type.slice(1);
}

function HeaderRow(): React.ReactElement {
  return (
    <Box>
      <Box width={COLUMN_WIDTHS.marker}>
        <Text>{"  "}</Text>
      </Box>
      <Box width={COLUMN_WIDTHS.identifier}>
        <Text bold color="gray">{pad("Issue", COLUMN_WIDTHS.identifier)}</Text>
      </Box>
      <Box width={COLUMN_WIDTHS.state}>
        <Text bold color="gray">{pad("State", COLUMN_WIDTHS.state)}</Text>
      </Box>
      <Box width={COLUMN_WIDTHS.assignee}>
        <Text bold color="gray">{pad("Assignee", COLUMN_WIDTHS.assignee)}</Text>
      </Box>
      <Box flexGrow={1}>
        <Text bold color="gray">Title</Text>
      </Box>
    </Box>
  );
}

function DigestRow({ item, highlighted }: { item: DigestItem; highlighted: boolean }): React.ReactElement {
  return (
    <Box>
      <Box width={COLUMN_WIDTHS.marker}>
        <Text color={highlighted ? "cyan" : undefined}>{highlighted ? "▸ " : "  "}</Text>
      </Box>
      <Box width={COLUMN_WIDTHS.identifier}>
        <Text color="cyan" bold={highlighted}>{pad(item.identifier, COLUMN_WIDTHS.identifier)}</Text>
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

/** Render recent issue activity grouped by workflow-state type. */
export function DigestPane({ result }: DigestPaneProps): React.ReactElement {
  const { exit } = useApp();
  const [cursor, setCursor] = useState<number>(0);
  const itemCount = useMemo(
    () => result.groups.reduce((total, group) => total + group.items.length, 0),
    [result.groups],
  );

  // Clamp cursor if a refreshed digest shrinks below it.
  useEffect(() => {
    setCursor((current) => Math.min(current, Math.max(0, itemCount - 1)));
  }, [itemCount]);

  useInput((input, key) => {
    if (itemCount === 0) {
      if (input === "q") exit();
      return;
    }

    if (input === "j" || key.downArrow) {
      setCursor((current) => Math.min(current + 1, itemCount - 1));
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

  let rowIndex = 0;

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text bold>
          Recent activity <Text color="gray">({result.total} {result.total === 1 ? "issue" : "issues"} since {result.since})</Text>
        </Text>
      </Box>

      {itemCount === 0 ? (
        <Box paddingX={1}>
          <Text color="green">No recent issue activity.</Text>
        </Box>
      ) : (
        result.groups.map((group) => (
          <Box key={group.type} flexDirection="column" marginBottom={1}>
            <Text bold color="yellow">{groupLabel(group.type)} ({group.count})</Text>
            <HeaderRow />
            {group.items.map((item) => {
              const index = rowIndex++;
              return (
                <DigestRow
                  key={`${group.type}:${item.identifier}`}
                  item={item}
                  highlighted={index === cursor}
                />
              );
            })}
          </Box>
        ))
      )}

      <Box marginTop={1}>
        <Text color="gray">j/k move · Enter detail · q quit</Text>
      </Box>
    </Box>
  );
}
