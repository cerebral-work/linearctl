import { input, select, confirm } from "@inquirer/prompts";
import type { LinearClient } from "@linear/sdk";

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
