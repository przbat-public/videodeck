import { extractYtDlpProgress, isYtDlpProgressLine } from '@videodeck/shared/progress';
import { extractYoutubeVideoId, toWatchUrl } from '@videodeck/shared/youtube';
import fc from 'fast-check';
import { extractTextFromVttSubtitles } from './services/summaryService';
import { runPool } from './utils/runPool';
import { stripVttCueSettings } from './utils/vttUtils';

/**
 * Property-based tests: invariants that must hold for EVERY input, not just
 * the examples. fast-check generates (and shrinks) counterexamples.
 */

describe('extractTextFromVttSubtitles', () => {
  it('never throws and never leaks markup/metadata', () => {
    fc.assert(
      fc.property(fc.string(), (input) => {
        const text = extractTextFromVttSubtitles(input);
        expect(text).not.toContain('-->');
        // text may legitimately contain < and >, but never yt-dlp's tags
        expect(text).not.toMatch(/<\d+:\d{2}:\d{2}\.\d{3}>/);
        expect(text).not.toMatch(/<\d{2}:\d{2}\.\d{3}>/);
        expect(text).not.toMatch(/<\/?c>/);
        expect(text).not.toContain('WEBVTT');
        expect(text).not.toMatch(/^(Kind|Language|Style):/);
      }),
    );
  });

  it('is idempotent on its own output', () => {
    fc.assert(
      fc.property(fc.string(), (input) => {
        const once = extractTextFromVttSubtitles(input);
        expect(extractTextFromVttSubtitles(once)).toBe(once);
      }),
    );
  });
});

describe('extractYtDlpProgress', () => {
  it('returns undefined or a percentage within 0..100 for any line', () => {
    fc.assert(
      fc.property(fc.string(), (line) => {
        const progress = extractYtDlpProgress(line);
        if (progress !== undefined) {
          expect(progress).toBeGreaterThanOrEqual(0);
          expect(progress).toBeLessThanOrEqual(100);
        }
      }),
    );
  });

  it('reads any percentage it is given', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 100 }), (percent) => {
        expect(extractYtDlpProgress(`[download] ${percent}% of 10MiB`)).toBe(percent);
      }),
    );
  });
});

describe('isYtDlpProgressLine', () => {
  it('flags only the two exact progress formats', () => {
    expect(isYtDlpProgressLine('download  12.3% (1.10GiB @ 69.50MiB/s, ETA 00:14)')).toBe(true);
    expect(isYtDlpProgressLine('[download]  45.2% of 123.45MiB at 1.23MiB/s ETA 00:45')).toBe(true);
    expect(isYtDlpProgressLine('download  100% (10MiB @ 1MiB/s, ETA 00:00)')).toBe(true);
  });

  it('never flags routine or error lines, whatever percent they mention', () => {
    expect(isYtDlpProgressLine('[download] Destination: video.mp4')).toBe(false);
    expect(isYtDlpProgressLine('[Merger] Merging formats into "video.mp4"')).toBe(false);
    expect(isYtDlpProgressLine('[download] video has already been recorded in the archive')).toBe(false);
    expect(isYtDlpProgressLine('ERROR: something failed at 42%')).toBe(false);
    expect(isYtDlpProgressLine('download failed at 99%')).toBe(false);
    expect(isYtDlpProgressLine('')).toBe(false);
  });

  it('is a property of the string itself, for any line', () => {
    fc.assert(
      fc.property(fc.string(), (line) => {
        expect(typeof isYtDlpProgressLine(line)).toBe('boolean');
      }),
    );
  });
});

describe('extractYoutubeVideoId', () => {
  it('returns null or exactly an 11-character id for any URL', () => {
    fc.assert(
      fc.property(fc.string(), (url) => {
        const id = extractYoutubeVideoId(url);
        if (id !== null) {
          expect(id).toMatch(/^[a-zA-Z0-9_-]{11}$/);
        }
      }),
    );
  });

  it('toWatchUrl produces a URL the extractor reads back, for any valid id', () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[a-zA-Z0-9_-]{11}$/), (id) => {
        expect(extractYoutubeVideoId(toWatchUrl(id))).toBe(id);
      }),
    );
  });

  it('toWatchUrl never carries playlist context', () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[a-zA-Z0-9_-]{11}$/), (id) => {
        const url = toWatchUrl(id);
        expect(url).not.toContain('list=');
        expect(url).not.toContain('index=');
      }),
    );
  });
});

describe('stripVttCueSettings', () => {
  it('never leaves cue settings behind, for any input', () => {
    fc.assert(
      fc.property(fc.string(), (input) => {
        const output = stripVttCueSettings(input);
        // timing lines must be bare timestamps, nothing position/align-ish
        for (const line of output.split('\n')) {
          if (line.includes('-->')) {
            expect(line).not.toMatch(/\s+(?:align|position|line|vertical|size):/);
          }
        }
      }),
    );
  });

  it('strips any settings tail from a cue line, leaving the bare timestamps', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 40 }), (settings) => {
        const withoutNewlines = settings.replace(/\r?\n/g, ' ');
        const line = `00:00:01.000 --> 00:00:02.000${withoutNewlines ? ` ${withoutNewlines}` : ''}`;
        expect(stripVttCueSettings(line)).toBe('00:00:01.000 --> 00:00:02.000');
      }),
    );
  });
});

describe('runPool', () => {
  it('processes every item exactly once, whatever the input and concurrency', () => {
    fc.assert(
      fc.asyncProperty(
        fc.array(fc.integer(), { maxLength: 40 }),
        fc.integer({ min: 1, max: 8 }),
        async (items, concurrency) => {
          const seen: number[] = [];
          await runPool(items, concurrency, async (item) => {
            seen.push(item);
          });
          expect([...seen].sort((a, b) => a - b)).toEqual([...items].sort((a, b) => a - b));
        },
      ),
    );
  });
});
