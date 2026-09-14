/**
 * Run `worker` for every item with at most `limit` workers in flight. The
 * worker receives its item only — callers keep their own aggregation, which
 * must tolerate interleaving (JS is single-threaded, so plain pushes/reads of
 * shared arrays are safe; only multi-await sequences need care).
 */
export async function runPool<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<void>
): Promise<void> {
  const size = Math.max(1, Math.min(limit, items.length));
  let nextIndex = 0;

  const runners = Array.from({ length: size }, async () => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) {
        return;
      }
      const item = items[index];
      if (item === undefined) {
        return;
      }
      await worker(item);
    }
  });

  await Promise.all(runners);
}
