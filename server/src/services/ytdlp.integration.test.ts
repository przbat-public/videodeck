import { spawnSync } from 'node:child_process';
import { buildYtDlpArgs } from './ytdlp';

/**
 * Real-yt-dlp tests for the argument templates the download queue uses.
 * Skipped by default — run against the installed binary with:
 *
 *   npm run test:ytdlp-integration
 *
 * `--simulate` makes yt-dlp resolve and validate everything (formats,
 * templates, extractors) without downloading a byte; the target is a famous,
 * stable public video.
 */

const runIntegration = process.env.RUN_YTDLP_INTEGRATION === '1';
const describeIntegration = runIntegration ? describe : describe.skip;

const VIDEO_URL = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';

// Fast options: no comments/subs — the target's comment pages can take
// minutes, and this test only exercises the argument template.
const FAST_OPTIONS = { maxHeight: 720, subLangs: [] as string[], writeComments: false };

describeIntegration('yt-dlp integration', () => {
  it('accepts the download argument template', () => {
    const args = buildYtDlpArgs({ type: 'download', videoUrl: VIDEO_URL, options: FAST_OPTIONS });

    const result = spawnSync('yt-dlp', [...args, '--simulate'], {
      encoding: 'utf-8',
      timeout: 120_000,
    });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
  });

  it('accepts the update argument template pinned to a stem', () => {
    const args = buildYtDlpArgs({
      type: 'update',
      videoUrl: VIDEO_URL,
      baseName: 'stem',
      options: FAST_OPTIONS,
    });

    const result = spawnSync('yt-dlp', [...args, '--simulate'], {
      encoding: 'utf-8',
      timeout: 120_000,
    });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
  });
});
