import ora from "ora";
import { isStyled } from "./style.js";

/**
 * Run `fn` behind a spinner when a human is watching (same gate as styled
 * tables: TTY + NO_COLOR unset). Headless paths run `fn` bare — no control
 * characters ever reach a pipe or a CI log.
 */
export async function withSpinner<T>(
  text: string,
  fn: () => Promise<T>,
): Promise<T> {
  if (!isStyled()) return fn();
  const spinner = ora(text).start();
  try {
    const result = await fn();
    spinner.succeed();
    return result;
  } catch (err) {
    spinner.fail();
    throw err;
  }
}
