// The mistake this file makes on purpose: a server module imported before the
// deep environment exists, the way a static import at the top of a suite does.
import '../services/downloadQueue';
import { createDeepServerTestEnv } from '@videodeck/test-infra/deepServerTestEnv';

/**
 * The deep environment points the server at its fakes through process.env,
 * and three server values are read once, when their module loads: the
 * Elasticsearch URL, the yt-dlp binary and the queue state file. A suite that
 * imports a server module before createDeepServerTestEnv has pinned them to
 * whatever the process held at that moment, so it would reach a real cluster,
 * spawn the real yt-dlp or rewrite a queue file outside the temp root while
 * its assertions read the fakes. The boot refuses that order instead.
 */
describe('deep environment boot order', () => {
  it('refuses to boot after a server module was imported before it', async () => {
    await expect(createDeepServerTestEnv()).rejects.toThrow(/imported before/);
  });
});
