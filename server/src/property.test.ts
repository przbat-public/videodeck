import { extractYtDlpProgress, isYtDlpProgressLine } from '@videodeck/shared/progress';
import { extractYoutubeVideoId, toWatchUrl } from '@videodeck/shared/youtube';
import fc from 'fast-check';
import { extractTextFromVttSubtitles } from './services/summaryService';
import { findVideoFiles, groupFilesByStemPrefix } from './services/videoScanner';
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

  it('reads the id from every host shape the embed code produces', () => {
    const id = 'dQw4w9WgXcQ';
    // The allowlist doubles as the server's SSRF guard, so it only ever holds
    // real YouTube hosts; the www form is the one the embed snippets emit.
    const urls = [
      `https://www.youtube-nocookie.com/embed/${id}`,
      `https://youtube-nocookie.com/embed/${id}`,
      `https://www.youtube.com/shorts/${id}`,
      `https://youtu.be/${id}`,
      `https://m.youtube.com/watch?v=${id}`,
    ];
    for (const url of urls) {
      expect({ url, id: extractYoutubeVideoId(url) }).toEqual({ url, id });
    }
    expect(extractYoutubeVideoId(`https://www.youtube-nocookie.com.evil.test/embed/${id}`)).toBeNull();
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

describe('groupFilesByStemPrefix', () => {
  /**
   * What the sidecar rules look at: media in either case, images of each kind
   * and size, subtitles, other metadata and a name that is the stem alone. The
   * `.5` names make the sibling video `<stem>.5`, as "Part 1.5" is beside
   * "Part 1": its metadata, its media, and a thumbnail and subtitles that read
   * like a size and languages of the stem.
   */
  const SIDECARS = [
    '.info.json',
    '.mp4',
    '.MP4',
    '.mkv',
    '.webp',
    '.jpg',
    '.jpeg',
    '.png',
    '.WEBP',
    '.mp4_4.webp',
    '.2.jpg',
    '.vtt',
    '.en.vtt',
    '.pl.vtt',
    '.description',
    '',
    '.5.info.json',
    '.5.mp4',
    '.5.webp',
    '.5.vtt',
    '.5.en.vtt',
  ];

  /** A few stems, dots in them included, and a shuffled part of their sidecars as the folder listing */
  const folderArb = fc.uniqueArray(fc.stringMatching(/^[aB.]{1,3}$/), { minLength: 1, maxLength: 4 }).chain((stems) =>
    fc.record({
      stems: fc.constant(stems),
      listing: fc.shuffledSubarray(stems.flatMap((stem) => SIDECARS.map((sidecar) => `${stem}${sidecar}`))),
    }),
  );

  it("gives findVideoFiles the answer of the whole listing from a stem's group alone", () => {
    // A rule that reads another stem's sibling differs only in a listing that
    // keeps that sibling's files and drops the stem's own, which the default
    // 100 runs missed in about three seeds of ten; 500 take some 40 ms
    fc.assert(
      fc.property(folderArb, ({ stems, listing }) => {
        const groups = groupFilesByStemPrefix(listing);
        for (const stem of [...stems, ...stems.map((each) => `${each}.5`)]) {
          expect(findVideoFiles(stem, groups.get(stem) ?? [])).toEqual(findVideoFiles(stem, listing));
        }
      }),
      { numRuns: 500 },
    );
  });
});
