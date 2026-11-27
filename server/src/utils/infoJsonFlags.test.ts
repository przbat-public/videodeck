import fc from 'fast-check';
import { DESCRIPTION_PROBE_BYTES, type InfoJsonFlags, scanInfoJsonFlags } from './infoJsonFlags';

const NO_FLAGS: InfoJsonFlags = { hasComments: false, hasDescription: false };

/** The rule the folder index applied to a parse of the whole file: the reference the scan must match */
function ruleOf(text: string): InfoJsonFlags {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return NO_FLAGS;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return NO_FLAGS;
  }
  const { comments, description } = parsed as Record<string, unknown>;
  return {
    hasComments: Array.isArray(comments) && comments.length > 0,
    hasDescription: typeof description === 'string' && description.trim().length > 0,
  };
}

/** The UTF-8 bytes of `text` in chunks of the given sizes, taken in turn; one chunk when none are given */
async function* chunksOf(text: string, sizes: number[] = []): AsyncGenerator<Uint8Array> {
  const bytes = Buffer.from(text, 'utf-8');
  let at = 0;
  for (let turn = 0; at < bytes.length; turn += 1) {
    const size = sizes.length > 0 ? (sizes[turn % sizes.length] ?? 1) : bytes.length;
    yield bytes.subarray(at, at + size);
    at += size;
  }
}

/** What the folder index records: a scan that fails, on a file cut short, counts as no flags */
async function flagsOf(text: string, sizes?: number[]): Promise<InfoJsonFlags> {
  try {
    return await scanInfoJsonFlags(chunksOf(text, sizes));
  } catch {
    return NO_FLAGS;
  }
}

/** Python's json.dumps, which is how yt-dlp writes: `, ` and `: ` separators, optionally ensure_ascii */
function pythonDumps(value: unknown, ensureAscii: boolean): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => pythonDumps(item, ensureAscii)).join(', ')}]`;
  }
  if (typeof value === 'object' && value !== null) {
    const members = Object.entries(value).map(
      ([key, item]) => `${pythonDumps(key, ensureAscii)}: ${pythonDumps(item, ensureAscii)}`,
    );
    return `{${members.join(', ')}}`;
  }
  const text = JSON.stringify(value) ?? 'null';
  if (!ensureAscii || typeof value !== 'string') {
    return text;
  }
  return text.replace(/[\u0080-￿]/g, (unit) => `\\u${unit.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/**
 * Tab indents, CRLF line ends, a tab after every colon and every closing
 * bracket on a line of its own, an empty list's too: a file formatted by hand
 * on Windows. A tab or a CR then sits where the scan must see past whitespace
 * to judge a value, after a key's colon and inside an empty comment list.
 * JSON.stringify with a tab indent puts neither there: it writes `": "` and
 * `[]`.
 */
function tabbedDumps(value: unknown, indent = ''): string {
  const inner = `${indent}\t`;
  if (Array.isArray(value)) {
    const items = value.map((item) => `\r\n${inner}${tabbedDumps(item, inner)}`);
    return `[${items.join(',')}\r\n${indent}]`;
  }
  if (typeof value === 'object' && value !== null) {
    const members = Object.entries(value).map(
      ([key, item]) => `\r\n${inner}${JSON.stringify(key)}:\t${tabbedDumps(item, inner)}`,
    );
    return `{${members.join(',')}\r\n${indent}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function serialize(object: unknown, format: 'compact' | 'pretty' | 'tabs-crlf' | 'python' | 'python-ascii'): string {
  switch (format) {
    case 'pretty':
      return JSON.stringify(object, null, 2);
    case 'tabs-crlf':
      return tabbedDumps(object);
    case 'python':
      return pythonDumps(object, false);
    case 'python-ascii':
      return pythonDumps(object, true);
    default:
      return JSON.stringify(object);
  }
}

/** Everything String.prototype.trim drops, the JSON whitespace and the Unicode spaces past it */
const BLANKS = [' ', '\n', '\t', '\r', '\u000b', '\u000c', ' ', '　', '﻿', ' ', ' '];

const descriptionArb = fc.oneof(
  fc.string({ unit: fc.constantFrom(...BLANKS), maxLength: 6 }),
  fc.string({ unit: fc.constantFrom(...BLANKS, 'a', 'ż', '"', '\\', '\u0008', '😀'), maxLength: 8 }),
  fc.string({ unit: 'grapheme', maxLength: 12 }),
  fc.jsonValue({ maxDepth: 1 }),
);

const commentsArb = fc.oneof(
  fc.constant([]),
  fc.array(fc.jsonValue({ maxDepth: 2 }), { maxLength: 4 }),
  fc.jsonValue({ maxDepth: 1 }),
);

/** The two names where they must not count: deeper in the tree, and inside strings */
const decoysArb = fc.record({
  nested: fc.constant({ comments: [{ id: 'x' }], description: 'not top-level' }),
  tags: fc.constant(['comments', 'description', '"comments": [1]']),
  title: fc.constantFrom('my comments', '"description": "x"', 'a\\"comments\\": [1'),
});

/** An info.json with or without each watched key, its keys in any order */
const infoArb = fc
  .record(
    {
      extra: fc.dictionary(fc.string({ maxLength: 6 }), fc.jsonValue({ maxDepth: 2 }), { maxKeys: 5 }),
      decoys: decoysArb,
      description: descriptionArb,
      comments: commentsArb,
      ranks: fc.array(fc.nat(), { minLength: 12, maxLength: 12 }),
    },
    { requiredKeys: ['extra', 'decoys', 'ranks'] },
  )
  .map(({ extra, decoys, description, comments, ranks }) => {
    const entries: Array<[string, unknown]> = [...Object.entries(extra), ...Object.entries(decoys)];
    if (description !== undefined) {
      entries.push(['description', description]);
    }
    if (comments !== undefined) {
      entries.push(['comments', comments]);
    }
    const ranked = entries.map((entry, n) => ({ entry, rank: ranks[n % ranks.length] ?? 0 }));
    ranked.sort((a, b) => a.rank - b.rank);
    return Object.fromEntries(ranked.map(({ entry }) => entry));
  });

describe('scanInfoJsonFlags', () => {
  it('agrees with a parse of the whole file for any key order, serialization and chunking', async () => {
    await fc.assert(
      fc.asyncProperty(
        infoArb,
        fc.constantFrom('compact', 'pretty', 'tabs-crlf', 'python', 'python-ascii' as const),
        fc.array(fc.integer({ min: 1, max: 40 }), { maxLength: 6 }),
        async (object, format, sizes) => {
          const text = serialize(object, format);
          expect(await flagsOf(text, sizes)).toEqual(ruleOf(text));
        },
      ),
      { numRuns: 2000 },
    );
  });

  it.each([
    ['an empty comment list', '{"comments": []}', NO_FLAGS],
    ['an empty comment list with blanks inside', '{"comments": [ \n ]}', NO_FLAGS],
    ['a comment list whose one element is null', '{"comments": [null]}', { hasComments: true, hasDescription: false }],
    ['null values', '{"comments": null, "description": null}', NO_FLAGS],
    ['values of another type', '{"comments": {"0": 1}, "description": 5}', NO_FLAGS],
    ['a description of escaped blanks', '{"description": " \\n\\t\\u3000"}', NO_FLAGS],
    ['a description of raw Unicode spaces', '{"description": "　  "}', NO_FLAGS],
    [
      'a description behind an escaped space',
      '{"description": "\\u0020x"}',
      { hasComments: false, hasDescription: true },
    ],
    ['escaped keys', '{"descr\\u0069ption": "x", "c\\u006fmments": [1]}', { hasComments: true, hasDescription: true }],
    [
      'a key written as escapes only',
      '{"\\u0064\\u0065\\u0073\\u0063\\u0072\\u0069\\u0070\\u0074\\u0069\\u006f\\u006e": "x"}',
      { hasComments: false, hasDescription: true },
    ],
    ['the names one level down', '{"x": {"comments": [1], "description": "y"}}', NO_FLAGS],
    ['the names inside strings', '{"title": "\\"comments\\": [1", "tags": ["description"]}', NO_FLAGS],
    [
      'a key too long to be watched before the watched ones',
      `{"${'k'.repeat(80)}": 1, "description": "d", "comments": [1]}`,
      { hasComments: true, hasDescription: true },
    ],
    ['a description with an escape JSON does not know', '{"description": "bad \\x escape"}', NO_FLAGS],
    ['a top-level array', '[{"comments": [1]}]', NO_FLAGS],
    ['an empty file', '', NO_FLAGS],
    ['a file that is no JSON', '{not json', NO_FLAGS],
    // JSON.parse refuses a byte order mark like any other byte before the value
    ['a file that starts with a byte order mark', '\uFEFF{"description": "d", "comments": [1]}', NO_FLAGS],
    ['a file cut off before the comments', '{"id": "x", "description": "d", "comm', NO_FLAGS],
    ['a file cut off inside the description', '{"id": "x", "description": "a long descr', NO_FLAGS],
  ])('reads %s the way a parse of the whole file does, byte by byte', async (_name, text, expected) => {
    expect(await flagsOf(text, [1])).toEqual(expected);
    expect(ruleOf(text)).toEqual(expected);
  });

  it('stops pulling bytes at the first comment once the description is known', async () => {
    // The comment list is what makes a file large, and yt-dlp writes it last
    async function* source(): AsyncGenerator<Uint8Array> {
      yield Buffer.from('{"id": "x", "description": "d", "comments": [{"id": "c1"', 'utf-8');
      throw new Error('read past the first comment');
    }

    await expect(scanInfoJsonFlags(source())).resolves.toEqual({ hasComments: true, hasDescription: true });
  });

  it('drops a key too long to be watched instead of keeping it whole', async () => {
    // Kept byte by byte, a key of a megabyte would sit in memory until its
    // closing quote and then be decoded whole
    const text = `{"${'k'.repeat(1024 * 1024)}": 1, "description": "d", "comments": [1]}`;
    const parse = vi.spyOn(JSON, 'parse');

    const flags = await flagsOf(text, [64 * 1024]);
    const longestParsed = Math.max(...parse.mock.calls.map(([input]) => input.length));
    parse.mockRestore();

    expect(flags).toEqual({ hasComments: true, hasDescription: true });
    // The longest key worth decoding: `description` written as \u escapes, in its quotes
    expect(longestParsed).toBeLessThanOrEqual(6 * 'description'.length + 2);
  });

  it('rejects a file that ends inside its top-level object before both flags are known', async () => {
    await expect(scanInfoJsonFlags(chunksOf('{"id": "x", "formats": [{"url": "'))).rejects.toThrow();
  });

  describe('where it departs from a parse of the whole file, on files yt-dlp does not write', () => {
    it('counts a file cut off after its first comment as having comments', async () => {
      const text = '{"id": "x", "description": "d", "comments": [{"id": "c1", "text": "cut';

      expect(await flagsOf(text)).toEqual({ hasComments: true, hasDescription: true });
      expect(ruleOf(text)).toEqual(NO_FLAGS);
    });

    it('takes the first of two equal keys, where a parse keeps the last', async () => {
      // The second key comes while the other flag is still open, so the scan reads it
      const comments = '{"comments": [], "comments": [1], "description": "d"}';
      const description = '{"description": " ", "description": "d", "comments": [1]}';

      expect(await flagsOf(comments)).toEqual({ hasComments: false, hasDescription: true });
      expect(await flagsOf(description)).toEqual({ hasComments: true, hasDescription: false });
      expect(ruleOf(comments)).toEqual({ hasComments: true, hasDescription: true });
      expect(ruleOf(description)).toEqual({ hasComments: true, hasDescription: true });
    });

    it('counts a description literal past DESCRIPTION_PROBE_BYTES without decoding it', async () => {
      const text = `{"description": "${' '.repeat(DESCRIPTION_PROBE_BYTES + 10)}"}`;

      expect((await flagsOf(text)).hasDescription).toBe(true);
      expect(ruleOf(text).hasDescription).toBe(false);
    });
  });
});
