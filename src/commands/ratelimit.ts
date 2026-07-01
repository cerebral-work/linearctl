import { printJson } from "../lib/output.js";
import { fetchRateLimit, isExhausted, type RateLimitAxis } from "../core/ratelimit.js";

function renderAxis(name: string, a: RateLimitAxis): string {
  const budget =
    a.remaining !== null && a.limit !== null
      ? `${a.remaining} / ${a.limit} remaining`
      : "(headers not present)";
  const reset = a.resetAt ? `   resets ${a.resetAt}` : "";
  return `${name.padEnd(11)} ${budget}${reset}\n`;
}

export interface RatelimitOptions {
  json?: boolean;
}

/**
 * `linearctl ratelimit` — probe org-level API quota before a batch run (T18).
 * Exits 2 when either axis is exhausted so `&&`-chains abort cleanly.
 * See docs/spec.md §7 item 7.
 */
export async function ratelimit(opts: RatelimitOptions): Promise<void> {
  const apiKey = process.env.LINEAR_API_KEY;
  if (!apiKey) {
    console.error(
      "error: LINEAR_API_KEY is not set — see README.md → Authentication.",
    );
    process.exit(1);
  }
  const info = await fetchRateLimit(apiKey);

  if (opts.json) {
    printJson(info);
  } else {
    process.stdout.write(
      renderAxis("requests", info.requests) + renderAxis("complexity", info.complexity),
    );
  }
  if (isExhausted(info)) process.exit(2);
}
