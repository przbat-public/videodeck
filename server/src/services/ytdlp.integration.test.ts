import { spawnSync } from 'node:child_process';
import { buildYtDlpArgs } from './ytdlp';

/**
 * The argument templates the download queue builds, checked by the real
 * yt-dlp: the twin of the fake in scripts/fake-bin, which checks the URL, the
 * refused flags and --ignore-config but never the templates. Skipped by
 * default; run against the yt-dlp on PATH with:
 *
 *   pnpm run test:ytdlp-integration
 *
 * CI installs the version and the extras server/Dockerfile pins, so a pin bump
 * to a release that drops or renames a flag the templates use turns that job
 * red, and so does an extras list that drops curl_cffi. Homebrew's yt-dlp
 * ships without curl_cffi, so the impersonate case fails against it.
 *
 * Nothing goes over the network. Every case targets a string that is not a
 * URL, and yt-dlp validates the whole command line (option names and arity,
 * the output and progress templates, --retry-sleep, the format selector)
 * before it extracts anything, so "is not a valid URL" means the template
 * was accepted.
 */

const runIntegration = process.env.RUN_YTDLP_INTEGRATION === '1';
const describeIntegration = runIntegration ? describe : describe.skip;

/** Fails extraction offline, after every option has been parsed and validated */
const OFFLINE_TARGET = 'not-a-url';
/** What the real binary prints once it accepted the command line */
const TEMPLATE_ACCEPTED = /'not-a-url' is not a valid URL/;

// Fast options: no comments or subtitles, since this test only exercises the
// argument template.
const FAST_OPTIONS = { maxHeight: 720, subLangs: [] as string[], writeComments: false };

const simulate = (args: string[]) =>
  spawnSync('yt-dlp', [...args, '--simulate'], { encoding: 'utf-8', timeout: 120_000 });

describeIntegration('yt-dlp integration', () => {
  it('rejects a flag yt-dlp does not have, so the binary under test is the real one', () => {
    const args = [
      ...buildYtDlpArgs({ type: 'download', videoUrl: OFFLINE_TARGET, options: FAST_OPTIONS }),
      '--definitely-not-a-yt-dlp-flag',
    ];

    const result = simulate(args);

    // The message is the proof: the fake exits 2 as well, for a target that
    // is not a YouTube URL
    expect(result.stderr).toMatch(/no such option: --definitely-not-a-yt-dlp-flag/);
    expect(result.status).toBe(2);
  });

  it('accepts the download argument template', () => {
    const args = buildYtDlpArgs({ type: 'download', videoUrl: OFFLINE_TARGET, options: FAST_OPTIONS });

    const result = simulate(args);

    expect(result.error).toBeUndefined();
    expect(result.stderr).toMatch(TEMPLATE_ACCEPTED);
  });

  it('accepts --impersonate chrome, so the curl_cffi it loads is installed', () => {
    // `impersonate: true` in a folder's config.json adds the flag. yt-dlp
    // looks the target up before it reads the URL, so a yt-dlp without
    // curl_cffi (Homebrew's, or a bare pip install) stops with
    // 'Impersonate target "chrome" is not available' and a traceback.
    const args = buildYtDlpArgs({
      type: 'download',
      videoUrl: OFFLINE_TARGET,
      options: { ...FAST_OPTIONS, impersonate: true },
    });
    expect(args.join(' ')).toContain('--impersonate chrome');

    const result = simulate(args);

    expect(result.error).toBeUndefined();
    expect(result.stderr).not.toMatch(/Impersonate target "chrome" is not available/);
    expect(result.stderr).toMatch(TEMPLATE_ACCEPTED);
  });

  it('accepts the update argument template pinned to a stem', () => {
    // A staged run: -o points into .videodeck-staging/<jobId>/
    const args = buildYtDlpArgs({
      id: 'job-1',
      type: 'update',
      videoUrl: OFFLINE_TARGET,
      baseName: 'stem',
      options: FAST_OPTIONS,
    });

    const result = simulate(args);

    expect(result.error).toBeUndefined();
    expect(result.stderr).toMatch(TEMPLATE_ACCEPTED);
  });

  it('accepts the comment repair argument template, staged like an update', () => {
    const args = buildYtDlpArgs({
      id: 'job-1',
      type: 'repair',
      videoUrl: OFFLINE_TARGET,
      baseName: 'stem',
      options: FAST_OPTIONS,
      writeComments: true,
    });

    const result = simulate(args);

    expect(result.error).toBeUndefined();
    expect(result.stderr).toMatch(TEMPLATE_ACCEPTED);
  });
});
