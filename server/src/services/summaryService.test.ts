import * as fs from 'node:fs/promises';
import OpenAI from 'openai';
import { metricsRegistry } from '../metrics';
import { logger } from '../utils/logger';
import {
  estimateTokenCount,
  extractTextFromVttSubtitles,
  generateSummary,
  isRateLimitError,
  resetInFlightSummaries,
  truncateTextToTokenLimit,
} from './summaryService';

jest.mock('node:fs/promises');
jest.mock('openai');

const mockedFs = fs as jest.Mocked<typeof fs>;
const MockedOpenAI = OpenAI as jest.MockedClass<typeof OpenAI>;

const INPUT = {
  folderPath: '/test/videos',
  baseName: '20231201_TestVideo',
  subtitlePath: '20231201_TestVideo.vtt',
};

const SUMMARY_PATH = '/test/videos/20231201_TestVideo.summary.txt';
const SUBTITLE_PATH = '/test/videos/20231201_TestVideo.vtt';

const VTT = `WEBVTT

00:00:01.000 --> 00:00:04.000
This is a test subtitle

00:00:05.000 --> 00:00:08.000
And another one`;

const mockOpenAIInstance = {
  chat: {
    completions: {
      create: jest.fn(),
    },
  },
};

function mockCompletion(summary: string, finishReason = 'stop') {
  return { choices: [{ message: { content: summary }, finish_reason: finishReason }] };
}

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
    const realFs = jest.requireActual('fs/promises') as typeof import('fs/promises');
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
    jest.clearAllMocks();
    resetInFlightSummaries();
    process.env.OPENAI_API_KEY = 'test-api-key';
    MockedOpenAI.mockImplementation(() => mockOpenAIInstance as unknown as OpenAI);
    mockedFs.writeFile.mockResolvedValue(undefined);
    // resolveContainedPath: identity realpath keeps the containment check green
    mockedFs.realpath.mockImplementation((p) => Promise.resolve(String(p)));
  });

  it('returns the cached summary without touching OpenAI or the subtitles', async () => {
    mockedFs.readFile.mockResolvedValueOnce('Cached summary' as never);

    const result = await generateSummary(INPUT);

    expect(result).toEqual({ summary: 'Cached summary', truncated: false });
    expect(mockedFs.readFile).toHaveBeenCalledWith(SUMMARY_PATH, 'utf-8');
    expect(mockOpenAIInstance.chat.completions.create).not.toHaveBeenCalled();
  });

  it('regenerates when the cache file is empty and writes the new summary back', async () => {
    mockedFs.readFile.mockResolvedValueOnce('' as never);
    mockedFs.readFile.mockResolvedValueOnce(VTT as never);
    mockOpenAIInstance.chat.completions.create.mockResolvedValue(mockCompletion('Fresh summary'));

    const result = await generateSummary(INPUT);

    expect(result).toEqual({ summary: 'Fresh summary', truncated: false });
    expect(mockedFs.readFile).toHaveBeenCalledWith(SUBTITLE_PATH, 'utf-8');
    expect(mockedFs.writeFile).toHaveBeenCalledWith(SUMMARY_PATH, 'Fresh summary', 'utf-8');
  });

  it('reports truncation for subtitle text over the token budget', async () => {
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
  });

  it('sends the cleaned subtitle text to OpenAI', async () => {
    const vttWithMetadata = `WEBVTT

1
00:00:01.000 --> 00:00:04.000
This is a test subtitle`;
    mockedFs.readFile.mockRejectedValueOnce(new Error('no cache'));
    mockedFs.readFile.mockResolvedValueOnce(vttWithMetadata as never);
    mockOpenAIInstance.chat.completions.create.mockResolvedValue(mockCompletion('Summary'));

    await generateSummary(INPUT);

    const createCall = mockOpenAIInstance.chat.completions.create.mock.calls[0];
    expect(createCall[0].messages[1].content).toContain('This is a test subtitle');
    expect(createCall[0].messages[1].content).not.toContain('00:00:01.000');
    expect(createCall[0].messages[1].content).not.toContain('WEBVTT');
  });

  it('moves to the next model when a 429 is hit', async () => {
    mockedFs.readFile.mockRejectedValueOnce(new Error('no cache'));
    mockedFs.readFile.mockResolvedValueOnce(VTT as never);
    const rateLimitError = Object.assign(new Error('Rate limit exceeded'), { status: 429 });
    mockOpenAIInstance.chat.completions.create
      .mockRejectedValueOnce(rateLimitError)
      .mockResolvedValueOnce(mockCompletion('Summary'));

    const result = await generateSummary(INPUT);

    expect(result.summary).toBe('Summary');
    expect(mockOpenAIInstance.chat.completions.create).toHaveBeenCalledTimes(2);
  });

  it('fails fast once every model is rate limited', async () => {
    mockedFs.readFile.mockRejectedValueOnce(new Error('no cache'));
    mockedFs.readFile.mockResolvedValueOnce(VTT as never);
    mockOpenAIInstance.chat.completions.create.mockRejectedValue(
      Object.assign(new Error('Rate limit exceeded'), { status: 429 }),
    );

    await expect(generateSummary(INPUT)).rejects.toThrow('Rate limit exceeded for all models');
    expect(mockOpenAIInstance.chat.completions.create).toHaveBeenCalledTimes(4);
    expect(mockedFs.writeFile).not.toHaveBeenCalled();
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
    mockOpenAIInstance.chat.completions.create.mockResolvedValue({ choices: [{}] });

    await expect(generateSummary(INPUT)).rejects.toThrow('OpenAI API did not return a summary');
  });

  it('propagates subtitle read errors', async () => {
    mockedFs.readFile.mockRejectedValueOnce(new Error('no cache'));
    mockedFs.readFile.mockRejectedValueOnce(new Error('Subtitle file not found'));

    await expect(generateSummary(INPUT)).rejects.toThrow('Subtitle file not found');
  });

  it('returns the summary even when writing the cache fails', async () => {
    mockedFs.readFile.mockRejectedValueOnce(new Error('no cache'));
    mockedFs.readFile.mockResolvedValueOnce(VTT as never);
    mockedFs.writeFile.mockRejectedValue(new Error('Write failed'));
    mockOpenAIInstance.chat.completions.create.mockResolvedValue(mockCompletion('Summary'));

    const result = await generateSummary(INPUT);

    expect(result.summary).toBe('Summary');
  });

  it('requires an OpenAI API key', async () => {
    delete process.env.OPENAI_API_KEY;
    mockedFs.readFile.mockRejectedValueOnce(new Error('no cache'));

    try {
      await expect(generateSummary(INPUT)).rejects.toThrow('OPENAI_API_KEY environment variable is required');
    } finally {
      process.env.OPENAI_API_KEY = 'test-api-key';
    }
    expect(mockOpenAIInstance.chat.completions.create).not.toHaveBeenCalled();
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
    expect(mockedFs.writeFile).toHaveBeenCalledTimes(1);
  });

  it('does not cache a summary cut off by finish_reason=length', async () => {
    mockedFs.readFile.mockRejectedValueOnce(new Error('no cache'));
    mockedFs.readFile.mockResolvedValueOnce(VTT as never);
    mockOpenAIInstance.chat.completions.create.mockResolvedValue(mockCompletion('The video is about', 'length'));

    const result = await generateSummary(INPUT);

    expect(result).toEqual({ summary: 'The video is about', truncated: true });
    expect(mockedFs.writeFile).not.toHaveBeenCalled();
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
    });
  });

  it('logs the billed tokens, approximate cost and records cost metrics', async () => {
    const infoSpy = jest.spyOn(logger, 'info').mockImplementation(() => {
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

    // 100/1M × $0.15 + 50/1M × $0.60 = $0.000045 = ≈$0.0045
    expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('≈$0.0045'));
    expect(metricsRegistry.getSingleMetric('openai_summary_requests_total')).toBeDefined();
    expect(metricsRegistry.getSingleMetric('openai_summary_tokens_total')).toBeDefined();
    expect(metricsRegistry.getSingleMetric('openai_summary_estimated_cost_cents_total')).toBeDefined();
    infoSpy.mockRestore();
  });
});
