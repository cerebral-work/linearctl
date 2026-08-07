/**
 * Milestone pane for `linearctl tui` (CER-1550).
 *
 * Pure presentation for pre-fetched `core/milestones.milestones()` data. Renders
 * the same per-milestone done/total burn-down shown by `linearctl milestone`,
 * with local `j`/`k` cursor navigation and `q` quit handling.
 */

import { Box, Text, useApp, useInput } from "ink";
import { useEffect, useState } from "react";
import type { MilestoneProgress, MilestoneResult } from "../../core/milestones.js";

export interface MilestonePaneProps {
  /** Pre-fetched milestone result (the app fetches before mounting the pane). */
  data: MilestoneResult;
}

const BAR_WIDTH = 20;

function progressBar(percent: number): string {
  const boundedPercent = Math.max(0, Math.min(100, percent));
  const filled = Math.round((boundedPercent / 100) * BAR_WIDTH);
  return `[${"█".repeat(filled)}${"░".repeat(BAR_WIDTH - filled)}]`;
}

function MilestoneRow({
  milestone,
  highlighted,
}: {
  milestone: MilestoneProgress;
  highlighted: boolean;
}): React.ReactElement {
  return (
    <Box>
      <Box width={2}>
        <Text color={highlighted ? "cyan" : undefined}>{highlighted ? "▸ " : "  "}</Text>
      </Box>
      <Box width={28}>
        <Text bold={highlighted} color={highlighted ? "cyan" : undefined}>
          {milestone.name}
        </Text>
      </Box>
      <Box marginRight={1}>
        <Text color="cyan">{progressBar(milestone.percent)}</Text>
      </Box>
      <Box width={6}>
        <Text bold={highlighted}>{String(milestone.percent).padStart(3)}%</Text>
      </Box>
      <Box width={10}>
        <Text bold={highlighted}>
          {milestone.done}/{milestone.total}
        </Text>
      </Box>
      {milestone.targetDate && <Text color="gray">due {milestone.targetDate}</Text>}
    </Box>
  );
}

/**
 * Render milestone burn-down bars. The pane owns its cursor and keyboard input,
 * while all Linear data is supplied by the app through `data`.
 */
export function MilestonePane({ data }: MilestonePaneProps): React.ReactElement {
  const { exit } = useApp();
  const [cursor, setCursor] = useState<number>(0);
  const items = data.milestones;

  // Clamp cursor if the milestone list shrinks below it.
  useEffect(() => {
    setCursor((current) => Math.min(current, Math.max(0, items.length - 1)));
  }, [items.length]);

  useInput((input, key) => {
    if (items.length === 0) {
      if (input === "q") exit();
      return;
    }

    if (input === "j" || key.downArrow) {
      setCursor((current) => Math.min(current + 1, items.length - 1));
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

  const count = items.length;

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text bold>
          Milestones{data.project ? ` — ${data.project}` : ""}{" "}
          <Text color="gray">
            ({count} {count === 1 ? "milestone" : "milestones"})
          </Text>
        </Text>
      </Box>
      {items.length === 0 ? (
        <Box paddingX={1}>
          <Text color="green">No milestones found.</Text>
        </Box>
      ) : (
        <Box flexDirection="column">
          {items.map((milestone, index) => (
            <MilestoneRow
              key={milestone.id}
              milestone={milestone}
              highlighted={index === cursor}
            />
          ))}
        </Box>
      )}
      <Box marginTop={1}>
        <Text color="gray">j/k move · q quit</Text>
      </Box>
    </Box>
  );
}
