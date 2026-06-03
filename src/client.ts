import { LinearClient } from "@linear/sdk";

/**
 * Build a {@link LinearClient} from the `LINEAR_API_KEY` environment variable.
 *
 * The key is operator-provisioned: it renders from 1Password
 * ("Cerebral · Linear API", vault `cloud`) into `~/.config/zsh/secrets.env` at
 * `chezmoi apply`, and is exported into the interactive shell. This CLI never
 * stores, prints, or persists the key — it only reads it from the process
 * environment at call time.
 */
export function makeClient(): LinearClient {
  const apiKey = process.env.LINEAR_API_KEY;
  if (!apiKey) {
    console.error(
      "error: LINEAR_API_KEY is not set.\n" +
        "  This CLI reads a Linear personal API key from the environment.\n" +
        "  It renders from 1Password into ~/.config/zsh/secrets.env at `chezmoi apply`,\n" +
        "  or export it for one run via `op run`. See README.md → Authentication.\n" +
        "  The key is never stored or printed by this tool.",
    );
    process.exit(1);
  }
  return new LinearClient({ apiKey });
}
