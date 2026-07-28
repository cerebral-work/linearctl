/**
 * Dashboard shell for `linearctl tui` (CER-1550).
 *
 * Renders the tab bar (`1`–`5`) and routes to the active pane. First slice:
 * only `2` (Triage) is live; the others are "not yet implemented" placeholders
 * (`docs/features/tui.md:60-68`, first-slice scope). Handles `1`–`5` pane
 * switching + global `q` quit.
 */

import { Box, Text, useApp, useInput } from "ink";
import { useState } from "react";
import type { TriageItem } from "../core/grooming.js";
import { TriagePane } from "./panes/triage.js";

export interface DashboardProps {
  items: TriageItem[];
  team?: string[];
}

const TABS = [
  { key: "1", label: "Digest" },
  { key: "2", label: "Triage" },
  { key: "3", label: "Milestone" },
  { key: "4", label: "Xref" },
  { key: "5", label: "Stale" },
] as const;

function TabBar({ activeIndex }: { activeIndex: number }): React.ReactElement {
  return (
    <Box marginBottom={1}>
      {TABS.map((tab, index) => (
        <Box key={tab.key} marginRight={2}>
          <Text color={index === activeIndex ? "cyan" : "gray"} bold={index === activeIndex}>
            [{tab.key}] {tab.label}
          </Text>
        </Box>
      ))}
    </Box>
  );
}

function NotImplemented({ name }: { name: string }): React.ReactElement {
  return (
    <Box paddingX={1}>
      <Text color="yellow">
        {name} pane — not yet implemented (first slice: Triage only).
      </Text>
    </Box>
  );
}

/**
 * The dashboard: tab bar + active pane. `1`–`5` switch panes, `q` quits.
 * Only the Triage pane is live; the `j`/`k` navigation for the cursor lives in
 * the pane itself (it owns the cursor state for its list).
 *
 * Both Dashboard and TriagePane register `useInput` handlers. Ink calls every
 * `useInput` callback for each keystroke — the Dashboard handles pane-switch
 * digits + `q`, the TriagePane handles `j`/`k`/`q` for its cursor. Non-matching
 * keys are ignored by each handler.
 */
export function Dashboard({ items, team }: DashboardProps): React.ReactElement {
  const { exit } = useApp();
  const [activePane, setActivePane] = useState<number>(1); // default: Triage

  useInput((input) => {
    const tabIndex = TABS.findIndex((tab) => tab.key === input);
    if (tabIndex !== -1) {
      setActivePane(tabIndex);
      return;
    }

    if (input === "q") {
      exit();
    }
  });

  const teamLabel = team && team.length > 0 ? team.join(", ") : "all teams";

  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Box marginBottom={1}>
        <Text bold>
          linearctl <Text color="gray">— {teamLabel}</Text>
        </Text>
      </Box>
      <TabBar activeIndex={activePane} />

      <Box flexDirection="column" flexGrow={1}>
        {activePane === 0 && <NotImplemented name="Digest" />}
        {activePane === 1 && <TriagePane items={items} />}
        {activePane === 2 && <NotImplemented name="Milestone" />}
        {activePane === 3 && <NotImplemented name="Xref" />}
        {activePane === 4 && <NotImplemented name="Stale" />}
      </Box>
    </Box>
  );
}
