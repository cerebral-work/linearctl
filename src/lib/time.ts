/**
 * Parse a relative duration like `7d`, `24h`, `2w`, `30m`, `45s` into a past
 * {@link Date}. A bare integer is treated as days. Throws on malformed input.
 *
 * @param spec  duration string — `<n>[s|m|h|d|w]`
 * @param now   reference point (defaults to current time; injectable for tests)
 */
export function sinceToDate(spec: string, now: Date = new Date()): Date {
  const m = /^(\d+)\s*([smhdw]?)$/.exec(spec.trim());
  if (!m) {
    throw new Error(
      `invalid --since value: "${spec}" (expected e.g. 7d, 24h, 2w, 30m)`,
    );
  }
  const n = Number(m[1]);
  const unit = m[2] || "d";
  const ms: Record<string, number> = {
    s: 1_000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
    w: 604_800_000,
  };
  return new Date(now.getTime() - n * ms[unit]);
}
