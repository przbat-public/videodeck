import fs from 'node:fs/promises';
import path from 'node:path';
import OpenAI from 'openai';
import { Counter } from 'prom-client';
import { getOpenAiApiKey } from '../config';
import { metricsRegistry } from '../metricsRegistry';
import { logger } from '../utils/logger';

/**
 * AI summaries of video subtitles (GET /api/videos/:identifier/summary).
 *
 * The pure helpers (VTT cleaning, token budgeting) are exported for tests;
 * `generateSummary` ties them together: read the `.summary.txt` cache, and
 * only when it is missing or empty, extract the subtitles' text and ask
 * OpenAI for a Polish summary, walking the model list on 429s. The result is
 * cached on disk, so a summary is generated at most once per video — and a
 * concurrent second request for the same video shares the in-flight call
 * instead of paying for a second one.
 */

// Models in order of preference (higher TPM limits first)
export const SUMMARY_MODELS = ['gpt-4o', 'gpt-4-turbo', 'gpt-4o-mini', 'gpt-4'] as const;

// Reserve tokens for: system prompt (~50), user prompt (~100), response (2000), and buffer
// TPM limit is 30000, but we want to be safe with ~25000 tokens for input
export const SUMMARY_MAX_INPUT_TOKENS = 25000;

/** Give up on a hung OpenAI call instead of holding the request forever */
export const OPENAI_TIMEOUT_MS = 60_000;

/**
 * Approximate USD prices per 1M tokens (input, output). They drift over time;
 * used only for logs and the cost metric — good enough to spot a runaway bill.
 */
const MODEL_PRICES: Record<(typeof SUMMARY_MODELS)[number], [number, number]> = {
  'gpt-4o': [2.5, 10],
  'gpt-4-turbo': [10, 30],
  'gpt-4o-mini': [0.15, 0.6],
  'gpt-4': [30, 60],
};

const summaryRequestsTotal = new Counter({
  name: 'openai_summary_requests_total',
  help: 'OpenAI summary requests, by model and outcome',
  labelNames: ['model', 'status'],
  registers: [metricsRegistry],
});

const summaryTokensTotal = new Counter({
  name: 'openai_summary_tokens_total',
  help: 'Tokens billed for video summaries, by model and kind',
  labelNames: ['model', 'type'],
  registers: [metricsRegistry],
});

const summaryEstimatedCostCents = new Counter({
  name: 'openai_summary_estimated_cost_cents_total',
  help: 'Estimated USD cents spent on video summaries, by model (approximate pricing)',
  labelNames: ['model'],
  registers: [metricsRegistry],
});

/** Whether the line is VTT machinery: header, metadata, timestamps, cue ids */
function isVttStructuralLine(line: string): boolean {
  return (
    !line ||
    line.startsWith('WEBVTT') ||
    /^(Kind|Language|Style):/i.test(line) ||
    line.includes('-->') ||
    /^\d+$/.test(line)
  );
}

/** Whether the line starts a NOTE/STYLE block that runs until an empty line */
function isVttNoteBlockStart(line: string): boolean {
  return line.startsWith('NOTE') || line.startsWith('STYLE');
}

/** Strip the inline tags yt-dlp writes: word timings and absolute timings */
function stripInlineTimingTags(line: string): string {
  return line
    .replace(/<\d+:\d{2}:\d{2}\.\d{3}>/g, ' ')
    .replace(/<\d{2}:\d{2}\.\d{3}>/g, ' ')
    .replace(/<\/?c>/g, ' ');
}

/**
 * Extracts plain text from VTT subtitle content by removing timestamps and
 * metadata. This significantly reduces token count for OpenAI API calls.
 *
 * Built against real yt-dlp output, which carries a `Kind:`/`Language:`
 * header block and inline timing tags like `<00:00:03.360>`.
 */
export function extractTextFromVttSubtitles(vttContent: string): string {
  const lines = vttContent.split('\n');
  const textLines: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] ?? '').trim();

    // Skip empty lines, the WEBVTT header, metadata, timestamps and cue ids
    if (isVttStructuralLine(line)) {
      continue;
    }
    // NOTE/STYLE blocks: skip every line until the next empty one
    if (isVttNoteBlockStart(line)) {
      while (i < lines.length - 1 && (lines[i + 1] ?? '').trim()) {
        i++;
      }
      continue;
    }

    // Actual subtitle text
    textLines.push(stripInlineTimingTags(line));
  }

  // Join lines with spaces, removing excessive whitespace
  // Multiple consecutive lines from same cue become one paragraph
  return textLines.join(' ').replace(/\s+/g, ' ').trim();
}

/**
 * Estimates approximate token count (rough estimate: 1 token ≈ 4 characters
 * for Polish text). This is a conservative estimate to avoid exceeding API
 * limits.
 */
export function estimateTokenCount(text: string): number {
  // Rough estimate: Polish text typically uses ~4 characters per token
  return Math.ceil(text.length / 4);
}

/**
 * Truncates text to fit within a token limit, keeping complete sentences when
 * possible. Leaves some buffer for system prompt and response tokens.
 */
export function truncateTextToTokenLimit(text: string, maxTokens: number): string {
  const estimatedTokens = estimateTokenCount(text);

  if (estimatedTokens <= maxTokens) {
    return text;
  }

  // Calculate max characters based on token limit
  const maxChars = maxTokens * 4;

  // Try to truncate at sentence boundary
  const truncated = text.substring(0, maxChars);
  const lastSentenceEnd = Math.max(
    truncated.lastIndexOf('.'),
    truncated.lastIndexOf('!'),
    truncated.lastIndexOf('?'),
    truncated.lastIndexOf('\n'),
  );

  // If we found a sentence boundary in the last 20% of text, use it
  if (lastSentenceEnd > maxChars * 0.8) {
    return text.substring(0, lastSentenceEnd + 1).trim();
  }

  // Otherwise, just truncate at character limit
  return truncated.trim();
}

/** HTTP 429 from the OpenAI SDK (`APIError.status`) or a wrapped response */
export function isRateLimitError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const { status, response } = error as { status?: unknown; response?: { status?: unknown } };
  return status === 429 || response?.status === 429;
}

export interface GenerateSummaryInput {
  folderPath: string;
  baseName: string;
  subtitlePath: string;
}

export interface GeneratedSummary {
  summary: string;
  /** True when the subtitles were cut to fit the model's token limit */
  truncated: boolean;
}

/** In-flight generations by summary file path — deduplicates concurrent calls */
const inFlight = new Map<string, Promise<GeneratedSummary>>();

/** Tests reset the map between cases (nothing to do when a promise settled) */
export function pendingSummaryCount(): number {
  return inFlight.size;
}

/** Drop all in-flight entries (tests only — production entries always settle) */
export function resetInFlightSummaries(): void {
  inFlight.clear();
}

/**
 * Return the cached summary or generate (and cache) a new one. Throws on
 * anything unrecoverable — callers let the error handler turn it into a 500.
 *
 * Two simultaneous requests for the same video share one OpenAI call: the
 * second caller awaits the same promise instead of paying for a duplicate.
 */
export async function generateSummary(input: GenerateSummaryInput): Promise<GeneratedSummary> {
  const { folderPath, baseName } = input;
  const summaryFilePath = path.join(folderPath, `${baseName}.summary.txt`);

  // A summary on disk wins — it was paid for once already
  try {
    const existingSummary = await fs.readFile(summaryFilePath, 'utf-8');
    if (existingSummary.trim()) {
      return { summary: existingSummary.trim(), truncated: false };
    }
  } catch {
    // File doesn't exist, continue to generate a new summary
  }

  const pending = inFlight.get(summaryFilePath);
  if (pending) {
    logger.info(`Summary for ${baseName}: joining the in-flight OpenAI call`);
    return pending;
  }

  const generation = generateUncached(input, summaryFilePath).finally(() => {
    inFlight.delete(summaryFilePath);
  });
  inFlight.set(summaryFilePath, generation);
  return generation;
}

async function generateUncached(input: GenerateSummaryInput, summaryFilePath: string): Promise<GeneratedSummary> {
  const { folderPath, baseName, subtitlePath } = input;
  const apiKey = getOpenAiApiKey();
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY environment variable is required');
  }

  const subtitleFilePath = path.join(folderPath, subtitlePath);
  const subtitleFileContent = await fs.readFile(subtitleFilePath, 'utf-8');

  // Extract only text content from VTT, removing timestamps and metadata
  // This significantly reduces token count for OpenAI API calls
  let subtitleText = extractTextFromVttSubtitles(subtitleFileContent);

  const estimatedTokens = estimateTokenCount(subtitleText);
  const wasTruncated = estimatedTokens > SUMMARY_MAX_INPUT_TOKENS;

  if (wasTruncated) {
    logger.warn(
      `Subtitle text is too long (estimated ${estimatedTokens} tokens). Truncating to ${SUMMARY_MAX_INPUT_TOKENS} tokens.`,
    );
    subtitleText = truncateTextToTokenLimit(subtitleText, SUMMARY_MAX_INPUT_TOKENS);
  }

  // No SDK retries (429s walk the model list here) and a hard timeout: a hung
  // OpenAI call must not pin the request (and the queue behind it) forever.
  const openai = new OpenAI({ apiKey, timeout: OPENAI_TIMEOUT_MS, maxRetries: 0 });
  const completion = await completeWithFallback(openai, subtitleText);

  const model = completion.model;
  summaryRequestsTotal.inc({ model, status: 'ok' });

  if (completion.usage) {
    recordUsage(baseName, model, completion.usage);
  }

  // Defensive `?.` on message: the API has returned choices without one
  const summary = completion.choices[0]?.message?.content;

  if (!summary) {
    throw new Error('OpenAI API did not return a summary');
  }

  // `finish_reason: 'length'` means the model hit max_tokens mid-sentence:
  // the summary is cut off. Return it marked as truncated and DO NOT cache it
  // — the cache must only ever hold complete summaries.
  const cutOff = completion.choices[0]?.finish_reason === 'length';
  if (cutOff) {
    logger.warn(
      `Summary for ${baseName}: model stopped at max_tokens (finish_reason=length) — not caching the partial summary`,
    );
    return { summary, truncated: true };
  }

  // Save summary to disk for future use
  try {
    await fs.writeFile(summaryFilePath, summary, 'utf-8');
  } catch (writeError) {
    logger.error('Error saving summary to disk:', writeError);
    // Continue even if save fails - still return the summary
  }

  return { summary, truncated: wasTruncated };
}

/** First model of the list that answers; 429s walk the list, other errors fail fast */
async function completeWithFallback(
  openai: OpenAI,
  subtitleText: string,
): Promise<OpenAI.Chat.Completions.ChatCompletion> {
  let lastError: unknown;

  for (const model of SUMMARY_MODELS) {
    try {
      // Call OpenAI API to generate summary in Polish
      return await openai.chat.completions.create({
        model,
        messages: [
          {
            role: 'system',
            content:
              'Jesteś pomocnym asystentem, który tworzy zwięzłe podsumowania napisów filmowych w języku polskim.',
          },
          {
            role: 'user',
            content: `Przeanalizuj poniższe napisy filmowe i stwórz zwięzłe podsumowanie w języku polskim. Podsumowanie powinno zawierać główne tematy i kluczowe punkty omawiane w filmie. Nie umieszczaj na początku podsumowania o tym że jest to podsumowanie filmu.\n\nNapisy:\n${subtitleText}`,
          },
        ],
        temperature: 0.7,
        max_tokens: 2000,
      });
    } catch (error) {
      lastError = error;
      summaryRequestsTotal.inc({ model, status: 'error' });
      if (!isRateLimitError(error)) {
        // For other errors, rethrow immediately
        throw error;
      }
      logger.warn(`Rate limit hit for model ${model}, trying next model...`);
      if (model === SUMMARY_MODELS[SUMMARY_MODELS.length - 1]) {
        // Every model is rate limited — fail fast, the client decides when to retry
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`Rate limit exceeded for all models. Please try again later. Original error: ${detail}`, {
          cause: error,
        });
      }
    }
  }

  throw new Error(
    lastError instanceof Error && lastError.message ? lastError.message : 'OpenAI API did not return a response',
  );
}

/** Record token usage and the approximate cost of a summary response */
function recordUsage(baseName: string, model: string, usage: OpenAI.CompletionUsage): void {
  summaryTokensTotal.inc({ model, type: 'prompt' }, usage.prompt_tokens);
  summaryTokensTotal.inc({ model, type: 'completion' }, usage.completion_tokens);
  const [inputPrice, outputPrice] = MODEL_PRICES[model as (typeof SUMMARY_MODELS)[number]] ?? [0, 0];
  const costCents =
    (usage.prompt_tokens / 1_000_000) * inputPrice * 100 + (usage.completion_tokens / 1_000_000) * outputPrice * 100;
  summaryEstimatedCostCents.inc({ model }, costCents);
  logger.info(
    `Summary for ${baseName}: model=${model} prompt=${usage.prompt_tokens} completion=${usage.completion_tokens} tokens, ≈$${costCents.toFixed(4)}`,
  );
}
