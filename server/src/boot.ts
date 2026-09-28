import { logger } from './utils/logger';

/**
 * The steps a boot fires after the port is open.
 *
 * Elasticsearch may be down, slow or unreachable at startup, so none of this
 * may delay the listener or fail the boot: the server serves what it can from
 * disk and the first request is not the place to find out. Keeping the order in
 * one small function is what makes it testable, since `index.ts` runs on import
 * and cannot be driven by a test.
 */

/** One piece of startup housekeeping, named for the log line a failure leaves */
export interface BootTask {
  name: string;
  run: () => Promise<void>;
}

/** Fire every task without waiting for any of them; a failure is logged, never thrown */
export function runBootTasks(tasks: readonly BootTask[]): void {
  for (const task of tasks) {
    void task.run().catch((error: unknown) => {
      logger.warn(`${task.name} failed at boot: ${error instanceof Error ? error.message : String(error)}`);
    });
  }
}

/**
 * Open the port, then hand over to the housekeeping. The listener comes first
 * on purpose: a cluster that answers slowly must not hold the port closed.
 */
export function startServing<T>(listen: () => T, tasks: readonly BootTask[]): T {
  const started = listen();
  runBootTasks(tasks);
  return started;
}
