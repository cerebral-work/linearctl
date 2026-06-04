/**
 * Map over items with bounded concurrency, preserving input order.
 *
 * Tames the per-item N+1 (spec §10): instead of N *serial* round-trips
 * (sluggish, and a cron foot-gun on a big team/project), at most `limit` run at
 * once — fast without flooding into `RATELIMITED`.
 */
export async function mapPool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
