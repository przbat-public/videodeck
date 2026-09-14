import { runPool } from './runPool';

/** A worker that records its active count and resolves after a tick */
function makeWorker() {
  let active = 0;
  let maxActive = 0;
  const seen: number[] = [];
  const worker = async (item: number): Promise<void> => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    seen.push(item);
    await Promise.resolve();
    active -= 1;
  };
  return { worker, seen: () => seen, maxActive: () => maxActive };
}

describe('runPool', () => {
  it('runs every item exactly once', async () => {
    const { worker, seen } = makeWorker();
    await runPool([0, 1, 2, 3, 4], 2, worker);
    expect(seen().sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4]);
  });

  it('never exceeds the concurrency limit', async () => {
    const { worker, maxActive } = makeWorker();
    await runPool(
      Array.from({ length: 12 }, (_, i) => i),
      3,
      worker
    );
    expect(maxActive()).toBeLessThanOrEqual(3);
    expect(maxActive()).toBeGreaterThan(1);
  });

  it('handles an empty list', async () => {
    const { worker, seen } = makeWorker();
    await runPool([], 4, worker);
    expect(seen()).toEqual([]);
  });

  it('rejects when a worker fails', async () => {
    await expect(
      runPool([1, 2, 3], 2, async (item) => {
        if (item === 2) {
          throw new Error('boom');
        }
      })
    ).rejects.toThrow('boom');
  });
});
