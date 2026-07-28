/**
 * Triage pane for `linearctl tui` (CER-1550).
 *
 * Calls `core/grooming.triage()` — the same function `linearctl triage` uses
 * (`docs/features/tui.md:147`). Pure presentation: the TUI never talks to Linear
 * directly (`tui.md:108-110`). Renders the triage queue in an `IssueTable` with
 * `j`/`k` cursor navigation (passed down from the app keyboard loop).
 */

import { Box, Text, useApp, useInput } from "ink";
import { useEffect, useState } from "react";
import type { TriageItem } from "../../core/grooming.js";
import { IssueTable } from "../components/table.js";

export interface TriagePaneProps {
  /** Pre-fetched triage items (the app fetches before mounting the pane). */
  items: TriageItem[];
}

/**
 * The Triage pane. Holds cursor state, renders the title + table, and handles
 * `j`/`k` navigation + `q` quit locally (the app delegates `q` to `useApp().exit`).
 */
export function TriagePane({ items }: TriagePaneProps): React.ReactElement {
  const { exit } = useApp();
  const [cursor, setCursor] = useState<number>(0);

  // Clamp cursor if the item list shrinks below it.
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
          Triage queue <Text color="gray">({count} {count === 1 ? "issue" : "issues"})</Text>
        </Text>
      </Box>
      <IssueTable items={items} cursor={cursor} />
      <Box marginTop={1}>
        <Text color="gray">
          j/k move · Enter detail · q quit
        </Text>
      </Box>
    </Box>
  );
}
