import { isStyled, pc } from "./style.js";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/**
 * Run `fn` behind a spinner when a human is watching (same gate as styled
 * tables: TTY + NO_COLOR unset). Headless paths run `fn` bare — no control
 * characters ever reach a pipe or a CI log.
 *
 * Hand-rolled rather than ora: ora's TTY rendering path stalls bun's event
 * loop on a real pty — an awaited fetch never settles (reproduced with ora
 * 9.4.1 + bun 1.3, minimal script, compiled and uncompiled). A bare
 * setInterval writing to stderr has no such problem. We deliberately skip
 * cursor-hiding so an interrupt can never leave the operator's terminal
 * with a hidden cursor.
 */
export async function withSpinner<T>(
  text: string,
  fn: () => Promise<T>,
): Promise<T> {
  if (!isStyled()) return fn();
  let i = 0;
  const timer = setInterval(() => {
    i = (i + 1) % FRAMES.length;
    process.stderr.write(`\r\x1b[2K${pc.cyan(FRAMES[i])} ${text}`);
  }, 80);
  const finish = (mark: string) => {
    clearInterval(timer);
    process.stderr.write(`\r\x1b[2K${mark} ${text}\n`);
  };
  try {
    const result = await fn();
    finish(pc.green("✔"));
    return result;
  } catch (err) {
    finish(pc.red("✖"));
    throw err;
  }
}
