import * as fs from 'node:fs/promises';
import OpenAI from 'openai';
import type { Mocked, MockedClass } from 'vitest';
import { metricsRegistry } from '../metrics';
import { at } from '../test-utils';
import { logger } from '../utils/logger';
import {
  activeGenerationCount,
  estimateTokenCount,
  extractTextFromVttSubtitles,
  generateSummary,
  isRateLimitError,
  resetInFlightSummaries,
  resetSummarySemaphore,
  SummaryUnavailableError,
  truncateTextToTokenLimit,
} from './summaryService';

vi.mock('node:fs/promises');
vi.mock('openai');

const mockedFs = fs as Mocked<typeof fs>;
const MockedOpenAI = OpenAI as MockedClass<typeof OpenAI>;

const INPUT = {
  folderPath: '/test/videos',
  baseName: '20231201_TestVideo',
  subtitlePath: '20231201_TestVideo.vtt',
};

const SUMMARY_PATH = '/test/videos/20231201_TestVideo.summary.txt';
const TRUNCATED_MARKER_PATH = '/test/videos/20231201_TestVideo.summary.truncated';
const SUBTITLE_PATH = '/test/videos/20231201_TestVideo.vtt';

const VTT = `WEBVTT

00:00:01.000 --> 00:00:04.000
This is a test subtitle

00:00:05.000 --> 00:00:08.000
And another one`;

const mockOpenAIInstance = {
  chat: {
    completions: {
      create: vi.fn(),
    },
  },
};

/**
 * Provider variables this suite owns. process.env outlives a test file inside
 * a vitest worker, and the deep server integration is a neighbour, so every case
 * starts from a clean slate and the originals go back in afterAll.
 */
const PROVIDER_ENV_VARS = [
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'DEEPSEEK_API_KEY',
  'DEEPSEEK_MODEL',
  'DEEPSEEK_BASE_URL',
  'SUMMARY_PROVIDER',
] as const;

const originalProviderEnv = new Map(PROVIDER_ENV_VARS.map((name) => [name, process.env[name]]));

function clearProviderEnv(): void {
  for (const name of PROVIDER_ENV_VARS) {
    delete process.env[name];
  }
}

afterAll(() => {
  for (const [name, value] of originalProviderEnv) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
});

function mockCompletion(summary: string, finishReason = 'stop') {
  return {
    model: 'gpt-4o',
    choices: [{ message: { content: summary }, finish_reason: finishReason }],
  };
}

/** The file handle handed out by the fs.open mock (writeTextAtomic) */
const mockFileHandle = {
  writeFile: vi.fn<(content: string, encoding: BufferEncoding) => Promise<void>>(),
  sync: vi.fn<() => Promise<void>>(),
  close: vi.fn<() => Promise<void>>(),
};

describe('extractTextFromVttSubtitles', () => {
  it('keeps only the spoken text', () => {
    expect(extractTextFromVttSubtitles(VTT)).toBe('This is a test subtitle And another one');
  });

  it('skips cue identifiers and metadata', () => {
    const vtt = `WEBVTT

1
00:00:01.000 --> 00:00:04.000
First line

2
00:00:05.000 --> 00:00:08.000
Second line`;
    expect(extractTextFromVttSubtitles(vtt)).toBe('First line Second line');
  });

  it('skips NOTE and STYLE blocks entirely', () => {
    const vtt = `WEBVTT

STYLE
::cue { color: red }

00:00:01.000 --> 00:00:04.000
Real text

NOTE this comment
is two lines long

00:00:05.000 --> 00:00:08.000
More text`;
    expect(extractTextFromVttSubtitles(vtt)).toBe('Real text More text');
  });

  it('replaces inline <c> timing tags with spaces', () => {
    const vtt = `WEBVTT

00:00:01.000 --> 00:00:04.000
Hello<c> there</c> friend`;
    expect(extractTextFromVttSubtitles(vtt)).toBe('Hello there friend');
  });

  it('handles a real yt-dlp VTT with header lines and inline timing tags', async () => {
    const realFs = (await vi.importActual<typeof import('fs/promises')>('fs/promises')) as typeof import('fs/promises');
    const vtt = await realFs.readFile(`${__dirname}/../test/fixtures/ytdlp-real.vtt`, 'utf-8');

    const text = extractTextFromVttSubtitles(vtt);

    expect(text).not.toContain('Kind:');
    expect(text).not.toContain('Language:');
    expect(text).not.toMatch(/<\d/);
    expect(text).not.toContain('-->');
    expect(text).toContain("well here's the project in a little more");
    expect(text).toContain('closer to finished form');
    expect(text).toContain('breadboard');
  });
});

describe('estimateTokenCount', () => {
  it('estimates roughly one token per four characters', () => {
    expect(estimateTokenCount('12345678')).toBe(2);
    expect(estimateTokenCount('123456789')).toBe(3);
    expect(estimateTokenCount('')).toBe(0);
  });
});

describe('truncateTextToTokenLimit', () => {
  it('returns short text unchanged', () => {
    expect(truncateTextToTokenLimit('short', 100)).toBe('short');
  });

  it('cuts at a sentence boundary when one is near the limit', () => {
    // 950 chars of filler, a sentence boundary at 950, then a tail that
    // pushes the whole text over the 1000-char budget (250 tokens)
    const text = `${'word '.repeat(190)}. ${'tail '.repeat(30)}`;
    const result = truncateTextToTokenLimit(text, 250); // 1000 chars
    expect(result.length).toBeLessThanOrEqual(1000);
    expect(result.endsWith('.')).toBe(true);
    expect(result).not.toContain('tail');
  });

  it('falls back to a hard cut without a boundary', () => {
    const text = 'no punctuation here just words '.repeat(100);
    const result = truncateTextToTokenLimit(text, 100); // 400 chars
    expect(result.length).toBeLessThanOrEqual(400);
  });
});

describe('isRateLimitError', () => {
  it('recognizes 429 in the top-level status or the wrapped response', () => {
    expect(isRateLimitError(Object.assign(new Error('x'), { status: 429 }))).toBe(true);
    expect(isRateLimitError({ response: { status: 429 } })).toBe(true);
  });

  it('rejects other statuses and non-objects', () => {
    expect(isRateLimitError(Object.assign(new Error('x'), { status: 500 }))).toBe(false);
    expect(isRateLimitError('nope')).toBe(false);
    expect(isRateLimitError(null)).toBe(false);
  });
});

describe('generateSummary', () => {
  beforeEach(() => {
    // resetAllMocks (not clear): leftover mockResolvedValueOnce queues from
    // a previous test used to leak into the next one.
    vi.resetAllMocks();
    resetInFlightSummaries();
    resetSummarySemaphore();
    clearProviderEnv();
    process.env.OPENAI_API_KEY = 'test-api-key';
    // Production code calls `new OpenAI(...)`, and an arrow function is not
    // constructible: the implementation has to be a function expression. The
    // reference stays lazy, so the factory does not read `mockOpenAIInstance`
    // while the module graph is still initialising.
    // biome-ignore lint/complexity/useArrowFunction: this mock stands in for a class, and an arrow function is not constructible.
    MockedOpenAI.mockImplementation(function () {
      return mockOpenAIInstance as unknown as OpenAI;
    });
    // resolveContainedPath: identity realpath keeps the containment check green
    mockedFs.realpath.mockImplementation((p) => Promise.resolve(String(p)));
    // Atomic text writes go through the mocked handle
    mockedFs.open.mockResolvedValue(mockFileHandle as unknown as import('node:fs/promises').FileHandle);
    mockedFs.rename.mockResolvedValue(undefined);
    mockFileHandle.writeFile.mockResolvedValue(undefined);
    mockFileHandle.sync.mockResolvedValue(undefined);
    mockFileHandle.close.mockResolvedValue(undefined);
    // Cache invalidation compares mtimes: by default the cached summary is
    // NEWER than the subtitles, so an existing cache wins.
    mockedFs.stat.mockImplementation(async (p) => ({ mtimeMs: p.toString().includes('.summary') ? 999 : 1 }) as never);
    mockedFs.rm.mockResolvedValue(undefined);
  });

  it('returns the cached summary without touching OpenAI or the subtitles', async () => {
    mockedFs.readFile.mockResolvedValueOnce('Cached summary' as never);

    const result = await generateSummary(INPUT);

    expect(result).toEqual({ summary: 'Cached summary', truncated: false });
    expect(mockedFs.readFile).toHaveBeenCalledWith(SUMMARY_PATH, 'utf-8');
    expect(mockOpenAIInstance.chat.completions.create).not.toHaveBeenCalled();
  });

  it('regenerates when the cached summary is older than the subtitles', async () => {
    // summary mtime 1 < subtitle mtime 2 → stale, regenerate
    mockedFs.stat.mockImplementation(async (p) => ({ mtimeMs: String(p).includes('.summary') ? 1 : 2 }) as never);
    mockedFs.readFile.mockResolvedValueOnce('Stale summary' as never);
    mockedFs.readFile.mockResolvedValueOnce(VTT as never);
    mockOpenAIInstance.chat.completions.create.mockResolvedValue(mockCompletion('Fresh summary'));

    const result = await generateSummary(INPUT);

    expect(result).toEqual({ summary: 'Fresh summary', truncated: false });
    expect(mockOpenAIInstance.chat.completions.create).toHaveBeenCalledTimes(1);
    expect(mockFileHandle.writeFile).toHaveBeenCalledWith('Fresh summary', 'utf-8');
    expect(mockedFs.rename).toHaveBeenCalledWith(expect.any(String), SUMMARY_PATH);
  });

  it('regenerates when the cache file is empty and writes the new summary back', async () => {
    mockedFs.readFile.mockResolvedValueOnce('' as never);
    mockedFs.readFile.mockResolvedValueOnce(VTT as never);
    mockOpenAIInstance.chat.completions.create.mockResolvedValue(mockCompletion('Fresh summary'));

    const result = await generateSummary(INPUT);

    expect(result).toEqual({ summary: 'Fresh summary', truncated: false });
    expect(mockedFs.readFile).toHaveBeenCalledWith(SUBTITLE_PATH, 'utf-8');
    expect(mockFileHandle.writeFile).toHaveBeenCalledWith('Fresh summary', 'utf-8');
  });

  it('reports truncation for subtitle text over the token budget and persists the marker', async () => {
    // The extracted text alone (timestamps stripped) is ~160k chars ≈ 40k
    // estimated tokens, well over SUMMARY_MAX_INPUT_TOKENS
    const longVtt = `WEBVTT\n\n${Array(4000)
      .fill('00:00:01.000 --> 00:00:04.000\nSome spoken words that keep going on. ')
      .join('\n')}`;
    mockedFs.readFile.mockRejectedValueOnce(new Error('no cache'));
    mockedFs.readFile.mockResolvedValueOnce(longVtt as never);
    mockOpenAIInstance.chat.completions.create.mockResolvedValue(mockCompletion('Summary of a long video'));

    const result = await generateSummary(INPUT);

    expect(result.summary).toBe('Summary of a long video');
    expect(result.truncated).toBe(true);
    expect(mockFileHandle.writeFile).toHaveBeenCalledWith('1', 'utf-8');
    expect(mockedFs.rename).toHaveBeenCalledWith(expect.any(String), TRUNCATED_MARKER_PATH);
  });

  it('serves the persisted truncated marker with a cached summary', async () => {
    mockedFs.readFile.mockImplementation(async (p) =>
      (p as string).includes('.summary.truncated') ? '1' : 'Cached summary',
    );

    const result = await generateSummary(INPUT);

    expect(result).toEqual({ summary: 'Cached summary', truncated: true });
    expect(mockOpenAIInstance.chat.completions.create).not.toHaveBeenCalled();
  });

  it('sends the cleaned subtitle text to OpenAI, delimited as untrusted data', async () => {
    const vttWithMetadata = `WEBVTT

1
00:00:01.000 --> 00:00:04.000
This is a test subtitle`;
    mockedFs.readFile.mockRejectedValueOnce(new Error('no cache'));
    mockedFs.readFile.mockResolvedValueOnce(vttWithMetadata as never);
    mockOpenAIInstance.chat.completions.create.mockResolvedValue(mockCompletion('Summary'));

    await generateSummary(INPUT);

    const createCall = at(mockOpenAIInstance.chat.completions.create.mock.calls, 0);
    const userContent = createCall[0].messages[1].content as string;
    expect(userContent).toContain('This is a test subtitle');
    expect(userContent).toContain('<subtitles>');
    expect(userContent).toContain('</subtitles>');
    expect(userContent).not.toContain('00:00:01.000');
    expect(userContent).not.toContain('WEBVTT');
    const systemContent = createCall[0].messages[0].content as string;
    expect(systemContent).toContain('niezaufane');
  });

  it('moves to the next model after honoring Retry-After on a 429', async () => {
    vi.useFakeTimers();
    try {
      mockedFs.readFile.mockRejectedValueOnce(new Error('no cache'));
      mockedFs.readFile.mockResolvedValueOnce(VTT as never);
      const rateLimitError = Object.assign(new Error('Rate limit exceeded'), {
        status: 429,
        headers: { 'retry-after': '1' },
      });
      mockOpenAIInstance.chat.completions.create
        .mockRejectedValueOnce(rateLimitError)
        .mockResolvedValueOnce(mockCompletion('Summary'));

      const pending = generateSummary(INPUT);
      await vi.advanceTimersByTimeAsync(1500);
      const result = await pending;

      expect(result.summary).toBe('Summary');
      expect(mockOpenAIInstance.chat.completions.create).toHaveBeenCalledTimes(2);
      // The first call used gpt-4o, the fallback gpt-4o-mini
      expect(at(mockOpenAIInstance.chat.completions.create.mock.calls, 0)[0].model).toBe('gpt-4o');
      expect(at(mockOpenAIInstance.chat.completions.create.mock.calls, 1)[0].model).toBe('gpt-4o-mini');
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails fast once every model is rate limited', async () => {
    vi.useFakeTimers();
    try {
      mockedFs.readFile.mockRejectedValueOnce(new Error('no cache'));
      mockedFs.readFile.mockResolvedValueOnce(VTT as never);
      mockOpenAIInstance.chat.completions.create.mockRejectedValue(
        Object.assign(new Error('Rate limit exceeded'), { status: 429, headers: { 'retry-after': '1' } }),
      );

      const pending = generateSummary(INPUT);
      const expectation = expect(pending).rejects.toThrow('Rate limit exceeded for all models');
      await vi.advanceTimersByTimeAsync(2500);
      await expectation;
      expect(mockOpenAIInstance.chat.completions.create).toHaveBeenCalledTimes(2);
      expect(mockFileHandle.writeFile).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('rethrows non-429 OpenAI errors immediately', async () => {
    mockedFs.readFile.mockRejectedValueOnce(new Error('no cache'));
    mockedFs.readFile.mockResolvedValueOnce(VTT as never);
    mockOpenAIInstance.chat.completions.create.mockRejectedValue(new Error('OpenAI API error'));

    await expect(generateSummary(INPUT)).rejects.toThrow('OpenAI API error');
    expect(mockOpenAIInstance.chat.completions.create).toHaveBeenCalledTimes(1);
  });

  it('throws when the API response carries no summary', async () => {
    mockedFs.readFile.mockRejectedValueOnce(new Error('no cache'));
    mockedFs.readFile.mockResolvedValueOnce(VTT as never);
    mockOpenAIInstance.chat.completions.create.mockResolvedValue({
      model: 'gpt-4o',
      choices: [{}],
    });

    await expect(generateSummary(INPUT)).rejects.toThrow('The openai API did not return a summary');
  });

  it('propagates subtitle read errors', async () => {
    mockedFs.readFile.mockRejectedValueOnce(new Error('no cache'));
    mockedFs.readFile.mockRejectedValueOnce(new Error('Subtitle file not found'));

    await expect(generateSummary(INPUT)).rejects.toThrow('Subtitle file not found');
  });

  it('returns the summary even when writing the cache fails', async () => {
    mockedFs.readFile.mockRejectedValueOnce(new Error('no cache'));
    mockedFs.readFile.mockResolvedValueOnce(VTT as never);
    mockFileHandle.writeFile.mockRejectedValue(new Error('Write failed'));
    mockOpenAIInstance.chat.completions.create.mockResolvedValue(mockCompletion('Summary'));

    const result = await generateSummary(INPUT);

    expect(result.summary).toBe('Summary');
  });

  it('requires an API key (typed SummaryUnavailableError naming the variables)', async () => {
    delete process.env.OPENAI_API_KEY;
    mockedFs.readFile.mockRejectedValueOnce(new Error('no cache'));

    const failure = await generateSummary(INPUT).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(SummaryUnavailableError);
    expect(failure).toMatchObject({ message: 'OPENAI_API_KEY or DEEPSEEK_API_KEY environment variable is required' });
    expect(mockOpenAIInstance.chat.completions.create).not.toHaveBeenCalled();
  });

  it('names the DeepSeek variable, and only it, when that provider is pinned without a key', async () => {
    delete process.env.OPENAI_API_KEY;
    process.env.SUMMARY_PROVIDER = 'deepseek';
    mockedFs.readFile.mockRejectedValueOnce(new Error('no cache'));

    await expect(generateSummary(INPUT)).rejects.toThrow('DEEPSEEK_API_KEY environment variable is required');
    expect(mockOpenAIInstance.chat.completions.create).not.toHaveBeenCalled();
  });

  it('caps concurrent OpenAI calls at MAX_CONCURRENT_GENERATIONS', async () => {
    mockedFs.readFile.mockRejectedValueOnce(new Error('no cache'));
    mockedFs.readFile.mockRejectedValueOnce(new Error('no cache'));
    mockedFs.readFile.mockRejectedValueOnce(new Error('no cache'));
    mockedFs.readFile.mockResolvedValueOnce(VTT as never);
    mockedFs.readFile.mockResolvedValueOnce(VTT as never);
    mockedFs.readFile.mockResolvedValueOnce(VTT as never);

    let running = 0;
    let peak = 0;
    const resolvers: Array<() => void> = [];
    mockOpenAIInstance.chat.completions.create.mockImplementation(
      () =>
        new Promise((resolve) => {
          running += 1;
          peak = Math.max(peak, running);
          resolvers.push(() => {
            running -= 1;
            resolve(mockCompletion('Summary'));
          });
        }),
    );

    // Three different videos (distinct baseName → no in-flight dedup)
    const calls = [
      generateSummary({ ...INPUT, baseName: 'a' }),
      generateSummary({ ...INPUT, baseName: 'b' }),
      generateSummary({ ...INPUT, baseName: 'c' }),
    ];
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    // With a concurrency cap of 2, the third call must still be waiting.
    expect(activeGenerationCount()).toBe(2);
    expect(mockOpenAIInstance.chat.completions.create).toHaveBeenCalledTimes(2);

    resolvers[0]?.();
    await new Promise((resolve) => setImmediate(resolve));
    // After the first release the third call proceeds
    expect(mockOpenAIInstance.chat.completions.create).toHaveBeenCalledTimes(3);
    expect(peak).toBeLessThanOrEqual(2);

    resolvers[1]?.();
    resolvers[2]?.();
    await Promise.all(calls);
    expect(activeGenerationCount()).toBe(0);
  });

  it('shares one OpenAI call between concurrent requests for the same video', async () => {
    mockedFs.readFile.mockRejectedValueOnce(new Error('no cache'));
    mockedFs.readFile.mockRejectedValueOnce(new Error('no cache'));
    mockedFs.readFile.mockResolvedValueOnce(VTT as never);
    let resolveCreate: (value: unknown) => void = () => {
      /* replaced by the pending create promise's executor below */
    };
    mockOpenAIInstance.chat.completions.create.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveCreate = resolve;
        }),
    );

    const first = generateSummary(INPUT);
    const second = generateSummary(INPUT);
    // Both calls are async — let them reach the (single) OpenAI call before
    // resolving it.
    await new Promise((resolve) => setImmediate(resolve));
    resolveCreate(mockCompletion('Shared summary'));
    const [a, b] = await Promise.all([first, second]);

    expect(a).toEqual({ summary: 'Shared summary', truncated: false });
    expect(b).toEqual(a);
    expect(mockOpenAIInstance.chat.completions.create).toHaveBeenCalledTimes(1);
    expect(mockFileHandle.writeFile).toHaveBeenCalledTimes(1);
  });

  it('does not cache a summary cut off by finish_reason=length', async () => {
    mockedFs.readFile.mockRejectedValueOnce(new Error('no cache'));
    mockedFs.readFile.mockResolvedValueOnce(VTT as never);
    mockOpenAIInstance.chat.completions.create.mockResolvedValue(mockCompletion('The video is about', 'length'));

    const result = await generateSummary(INPUT);

    expect(result).toEqual({ summary: 'The video is about', truncated: true });
    expect(mockFileHandle.writeFile).not.toHaveBeenCalled();
  });

  it('creates the OpenAI client without SDK retries and with a hard timeout', async () => {
    mockedFs.readFile.mockRejectedValueOnce(new Error('no cache'));
    mockedFs.readFile.mockResolvedValueOnce(VTT as never);
    mockOpenAIInstance.chat.completions.create.mockResolvedValue(mockCompletion('Summary'));

    await generateSummary(INPUT);

    expect(MockedOpenAI).toHaveBeenCalledWith({
      apiKey: 'test-api-key',
      timeout: 60000,
      maxRetries: 0,
      dangerouslyAllowBrowser: false,
    });
  });

  it('switches to DeepSeek on its key alone, with its endpoint and the thinking mode off', async () => {
    delete process.env.OPENAI_API_KEY;
    process.env.DEEPSEEK_API_KEY = 'ds-test-key';
    mockedFs.readFile.mockRejectedValueOnce(new Error('no cache'));
    mockedFs.readFile.mockResolvedValueOnce(VTT as never);
    mockOpenAIInstance.chat.completions.create.mockResolvedValue({
      ...mockCompletion('DeepSeek summary'),
      model: 'deepseek-flash',
    });

    const result = await generateSummary(INPUT);

    expect(result.summary).toBe('DeepSeek summary');
    expect(MockedOpenAI).toHaveBeenCalledWith({
      apiKey: 'ds-test-key',
      baseURL: 'https://api.deepseek.com',
      timeout: 60000,
      maxRetries: 0,
      dangerouslyAllowBrowser: false,
    });
    const body = at(mockOpenAIInstance.chat.completions.create.mock.calls, 0)[0];
    expect(body.model).toBe('deepseek-flash');
    // Thinking mode ignores temperature and bills reasoning a summary does not need
    expect(body.thinking).toEqual({ type: 'disabled' });
    expect(body.temperature).toBe(0.7);
    expect(body.max_tokens).toBe(2000);
  });

  it('sends the reasoning effort from `model:effort` and drops the ignored temperature', async () => {
    delete process.env.OPENAI_API_KEY;
    process.env.DEEPSEEK_API_KEY = 'ds-test-key';
    process.env.DEEPSEEK_MODEL = 'deepseek-v4-pro:max';
    mockedFs.readFile.mockRejectedValueOnce(new Error('no cache'));
    mockedFs.readFile.mockResolvedValueOnce(VTT as never);
    mockOpenAIInstance.chat.completions.create.mockResolvedValue(mockCompletion('Summary'));

    await generateSummary(INPUT);

    const body = at(mockOpenAIInstance.chat.completions.create.mock.calls, 0)[0];
    expect(body.model).toBe('deepseek-v4-pro');
    expect(body.thinking).toEqual({ type: 'enabled' });
    expect(body.reasoning_effort).toBe('max');
    expect(body.temperature).toBeUndefined();
    // Reasoning shares the output budget, so the cap is higher than 2000
    expect(body.max_tokens).toBeGreaterThan(2000);
  });

  it('honours DEEPSEEK_MODEL and DEEPSEEK_BASE_URL, which is how the mock server is reached', async () => {
    delete process.env.OPENAI_API_KEY;
    process.env.DEEPSEEK_API_KEY = 'ds-test-key';
    process.env.DEEPSEEK_MODEL = 'deepseek-v4-pro';
    process.env.DEEPSEEK_BASE_URL = 'http://127.0.0.1:9999/v1';
    mockedFs.readFile.mockRejectedValueOnce(new Error('no cache'));
    mockedFs.readFile.mockResolvedValueOnce(VTT as never);
    mockOpenAIInstance.chat.completions.create.mockResolvedValue(mockCompletion('Summary'));

    await generateSummary(INPUT);

    expect(MockedOpenAI).toHaveBeenCalledWith(expect.objectContaining({ baseURL: 'http://127.0.0.1:9999/v1' }));
    expect(at(mockOpenAIInstance.chat.completions.create.mock.calls, 0)[0].model).toBe('deepseek-v4-pro');
  });

  it('keeps OpenAI when SUMMARY_PROVIDER pins it, even though a DeepSeek key is present', async () => {
    process.env.DEEPSEEK_API_KEY = 'ds-test-key';
    process.env.SUMMARY_PROVIDER = 'openai';
    mockedFs.readFile.mockRejectedValueOnce(new Error('no cache'));
    mockedFs.readFile.mockResolvedValueOnce(VTT as never);
    mockOpenAIInstance.chat.completions.create.mockResolvedValue(mockCompletion('Summary'));

    await generateSummary(INPUT);

    expect(MockedOpenAI).toHaveBeenCalledWith(expect.objectContaining({ apiKey: 'test-api-key' }));
    expect(at(mockOpenAIInstance.chat.completions.create.mock.calls, 0)[0].model).toBe('gpt-4o');
  });

  it('logs the billed tokens, approximate cost and records cost metrics per provider', async () => {
    const infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => {
      /* silence the expected billing log */
    });
    mockedFs.readFile.mockRejectedValueOnce(new Error('no cache'));
    mockedFs.readFile.mockResolvedValueOnce(VTT as never);
    mockOpenAIInstance.chat.completions.create.mockResolvedValue({
      ...mockCompletion('Summary'),
      model: 'gpt-4o-mini',
      usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
    });

    await generateSummary(INPUT);

    // 100/1M × $0.15 + 50/1M × $0.60 = $0.000045 = 0.0045 cents
    expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('provider=openai'));
    expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('≈0.0045 cents'));
    expect(metricsRegistry.getSingleMetric('summary_requests_total')).toBeDefined();
    expect(metricsRegistry.getSingleMetric('summary_tokens_total')).toBeDefined();
    const costMetric = metricsRegistry.getSingleMetric('summary_estimated_cost_cents_total');
    expect(costMetric).toBeDefined();
    expect((await costMetric?.get())?.values).toContainEqual(
      expect.objectContaining({ labels: { provider: 'openai', model: 'gpt-4o-mini' } }),
    );
    infoSpy.mockRestore();
  });

  it('prices a DeepSeek summary with the DeepSeek rate, not the OpenAI one', async () => {
    const infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => {
      /* silence the expected billing log */
    });
    delete process.env.OPENAI_API_KEY;
    process.env.DEEPSEEK_API_KEY = 'ds-test-key';
    mockedFs.readFile.mockRejectedValueOnce(new Error('no cache'));
    mockedFs.readFile.mockResolvedValueOnce(VTT as never);
    mockOpenAIInstance.chat.completions.create.mockResolvedValue({
      ...mockCompletion('Summary'),
      model: 'deepseek-flash',
      usage: { prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100 },
    });

    await generateSummary(INPUT);

    // 1000/1M × $0.15 + 100/1M × $0.60 = $0.00021 = 0.021 cents
    expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('provider=deepseek'));
    expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('≈0.0210 cents'));
    const costMetric = metricsRegistry.getSingleMetric('summary_estimated_cost_cents_total');
    expect((await costMetric?.get())?.values).toContainEqual(
      expect.objectContaining({ labels: { provider: 'deepseek', model: 'deepseek-flash' } }),
    );
    infoSpy.mockRestore();
  });
});
