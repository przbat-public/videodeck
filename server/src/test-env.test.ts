import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The queue state file is a real file a running dev server also writes. The
 * suite once rewrote `server/.queue-state.json` from a test run and took a live
 * queue's pending jobs with it, so the temporary location is pinned here.
 */
describe('the server test environment', () => {
  it('keeps the queue state file out of the checkout', () => {
    const stateFile = process.env.QUEUE_STATE_FILE ?? '';

    expect(stateFile.endsWith('.json')).toBe(true);
    expect(path.dirname(stateFile)).toBe(os.tmpdir());
    expect(stateFile.startsWith(process.cwd())).toBe(false);
  });
});
