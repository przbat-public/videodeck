import type { SpawnedProcess } from './queue';

/**
 * Killing a spawned yt-dlp process.
 *
 * Detection stays on `DownloadQueue`: the idle and wall-clock thresholds and
 * the per-job timers are instance state. The kill is here because ending the
 * process group is the destructive step, and two callers need it (a cancel and
 * the watchdog).
 */

/**
 * Signal the child and its whole process group (yt-dlp spawns ffmpeg as a
 * group member; killing only the parent would orphan the merge process).
 * Group kills need the child spawned with `detached: true`.
 */
export function killProcessGroup(child: SpawnedProcess | undefined, signal: NodeJS.Signals): void {
  if (!child) {
    return;
  }
  child.kill(signal);
  if (child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal);
    } catch {
      // Group already gone — nothing left to signal
    }
  }
}
