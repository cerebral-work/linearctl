import { input, select, confirm, search } from "@inquirer/prompts";
import type { LinearClient } from "@linear/sdk";
import { LinearDocument } from "@linear/sdk";
import { collectIssuesFlat, scopedTeams, type FlatIssueNode } from "../core/issues-query.js";

/**
 * Thin wrappers over @inquirer/prompts so commands never import the prompt
 * library directly — the interactive surface stays swappable (ADR territory)
 * and greppable in one file.
 */

export async function promptText(message: string): Promise<string> {
  return input({ message, required: true });
}

export async function promptOptionalText(message: string): Promise<string | undefined> {
  const value = await input({ message: `${message} (optional)` });
  return value.trim() === "" ? undefined : value;
}

/** Select a team key from the workspace's teams. */
export async function promptTeamKey(client: LinearClient): Promise<string> {
  const teams = await client.teams({ first: 50 });
  return select({
    message: "Team",
    choices: teams.nodes.map((t) => ({
      name: `${t.key} — ${t.name}`,
      value: t.key,
    })),
  });
}

export async function promptSelect(
  message: string,
  choices: Array<{ name: string; value: string }>,
): Promise<string> {
  return select({ message, choices });
}

export async function promptConfirm(message: string): Promise<boolean> {
  return confirm({ message, default: false });
}

const IDENTIFIER_RE = /^[a-z]+-\d+$/i;

/**
 * Build the choice list for the fuzzy issue picker from a pre-fetched set.
 * Pure — exported for tests. Local substring match over "IDENTIFIER title";
 * a term that already looks like an identifier is always offered directly,
 * so recent-issue capping never locks out an exact reference.
 */
export function issueChoices(
  items: Array<Pick<FlatIssueNode, "identifier" | "title">>,
  term: string,
): Array<{ name: string; value: string }> {
  const t = term.trim().toLowerCase();
  const matches = (t
    ? items.filter((i) => `${i.identifier} ${i.title}`.toLowerCase().includes(t))
    : items
  )
    .slice(0, 25)
    .map((i) => ({ name: `${i.identifier}  ${i.title}`, value: i.identifier }));
  if (
    IDENTIFIER_RE.test(t) &&
    !matches.some((m) => m.value.toLowerCase() === t)
  ) {
    matches.unshift({ name: `${t.toUpperCase()} (use directly)`, value: t.toUpperCase() });
  }
  return matches;
}

/**
 * Fuzzy-pick an issue: one capped fetch of the most recently updated active
 * issues (2 pages max — rate-budget conscious), then local filtering per
 * keystroke. Typing an exact identifier (e.g. CER-123) always works even if
 * it's outside the fetched window.
 */
export async function promptIssuePick(
  client: LinearClient,
  message: string,
  teamKeys?: string[],
): Promise<string> {
  const teams = scopedTeams(teamKeys);
  const items = await collectIssuesFlat(
    client,
    {
      ...(teams ? { team: { key: { in: teams } } } : {}),
      and: [{ state: { type: { nin: ["completed", "canceled"] } } }],
    },
    LinearDocument.PaginationOrderBy.UpdatedAt,
    200,
  );
  return search({
    message,
    source: (term) => issueChoices(items, term ?? ""),
  });
}
