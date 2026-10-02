import { runBootTasks, startServing } from './boot';
import { logger } from './utils/logger';

/** One real loop turn, so the fire-and-forget tasks settle */
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('startServing', () => {
  it('opens the port before it fires the boot tasks, and does not wait for them', async () => {
    // Ordering is the point: Elasticsearch may be slow or down at boot, and
    // none of the housekeeping may delay the listener or fail the startup.
    const order: string[] = [];

    const server = startServing(() => {
      order.push('listen');
      return { port: 3001 };
    }, [
      {
        name: 'sweep',
        run: async () => {
          await flush();
          order.push('sweep');
        },
      },
      { name: 'mappings', run: async () => void order.push('mappings') },
    ]);

    expect(server).toEqual({ port: 3001 });
    // The slower task has not settled: the boot did not wait for it
    expect(order).toEqual(['listen', 'mappings']);
    await flush();
    expect(order).toEqual(['listen', 'mappings', 'sweep']);
  });

  it('keeps the boot alive when a task fails, and names the task that did', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {
      /* the warning is the assertion */
    });
    const order: string[] = [];

    expect(() =>
      startServing(
        () => void order.push('listen'),
        [
          {
            name: 'orphan index sweep',
            run: async () => {
              throw new Error('connect ECONNREFUSED');
            },
          },
          { name: 'legacy mapping check', run: async () => void order.push('mappings') },
        ],
      ),
    ).not.toThrow();

    await flush();
    expect(order).toEqual(['listen', 'mappings']);
    expect(String(warn.mock.calls[0]?.[0])).toContain('orphan index sweep');
    expect(String(warn.mock.calls[0]?.[0])).toContain('connect ECONNREFUSED');
    warn.mockRestore();
  });

  it('runs nothing without tasks, so a bare listen stays a bare listen', () => {
    expect(runBootTasks([])).toBeUndefined();
    expect(startServing(() => 'server', [])).toBe('server');
  });
});
