import fs from 'fs/promises';
import path from 'path';
import OpenAI from 'openai';
import { logger } from '../utils/logger';
import { getOpenAiApiKey } from '../config';

/**
 * AI summaries of video subtitles (GET /api/videos/:identifier/summary).
 *
 * The pure helpers (VTT cleaning, token budgeting) are exported for tests;
 * `generateSummary` ties them together: read the `.summary.txt` cache, and
 * only when it is missing or empty, extract the subtitles' text and ask
 * OpenAI for a Polish summary, walking the model list on 429s. The result is
 * cached on disk, so a summary is generated at most once per video.
 */

// Models in order of preference (higher TPM limits first)
export const SUMMARY_MODELS = ['gpt-4o', 'gpt-4-turbo', 'gpt-4o-mini', 'gpt-4'] as const;

// Reserve tokens for: system prompt (~50), user prompt (~100), response (2000), and buffer
// TPM limit is 30000, but we want to be safe with ~25000 tokens for input
export const SUMMARY_MAX_INPUT_TOKENS = 25000;

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

    // Skip empty lines
    if (!line) continue;

    // Skip WEBVTT header and the yt-dlp metadata lines that follow it
    if (line === 'WEBVTT' || line.startsWith('WEBVTT')) continue;
    if (/^(Kind|Language|Style):/i.test(line)) continue;

    // Skip timestamp lines (format: 00:00:01.000 --> 00:00:04.000,
    // optionally with `align:start position:0%` after the arrow)
    if (line.includes('-->')) continue;

    // Skip cue identifiers (numeric lines that appear before timestamps)
    if (/^\d+$/.test(line)) continue;

    // Skip style/note blocks
    if (line.startsWith('NOTE') || line.startsWith('STYLE')) {
      // Skip until empty line
      while (i < lines.length - 1 && (lines[i + 1] ?? '').trim()) {
        i++;
      }
      continue;
    }

    // This is actual subtitle text; strip the inline tags yt-dlp writes:
    // <c>/</c> word timings and <00:00:03.360> absolute timings
    textLines.push(
      line
        .replace(/<\d+:\d{2}:\d{2}\.\d{3}>/g, ' ')
        .replace(/<\d{2}:\d{2}\.\d{3}>/g, ' ')
        .replace(/<\/?c>/g, ' ')
    );
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
    truncated.lastIndexOf('\n')
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

/**
 * Return the cached summary or generate (and cache) a new one. Throws on
 * anything unrecoverable — callers let the error handler turn it into a 500.
 */
export async function generateSummary(input: GenerateSummaryInput): Promise<GeneratedSummary> {
  const { folderPath, baseName, subtitlePath } = input;
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

  const apiKey = getOpenAiApiKey();
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY environment variable is required');
  }

  const subtitleFilePath = path.join(folderPath, subtitlePath);
  const subtitleFileContent = await fs.readFile(subtitleFilePath, 'utf-8');

  // Extract only text content from VTT, removing timestamps and metadata
  // This significantly reduces token count for OpenAI API
  let subtitleText = extractTextFromVttSubtitles(subtitleFileContent);

  const estimatedTokens = estimateTokenCount(subtitleText);
  const wasTruncated = estimatedTokens > SUMMARY_MAX_INPUT_TOKENS;

  if (wasTruncated) {
    logger.warn(
      `Subtitle text is too long (estimated ${estimatedTokens} tokens). Truncating to ${SUMMARY_MAX_INPUT_TOKENS} tokens.`
    );
    subtitleText = truncateTextToTokenLimit(subtitleText, SUMMARY_MAX_INPUT_TOKENS);
  }

  const openai = new OpenAI({ apiKey });

  let completion: OpenAI.Chat.Completions.ChatCompletion | undefined;
  let lastError: unknown;

  for (const model of SUMMARY_MODELS) {
    try {
      // Call OpenAI API to generate summary in Polish
      completion = await openai.chat.completions.create({
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
      break; // Success, exit loop
    } catch (error) {
      lastError = error;
      if (!isRateLimitError(error)) {
        // For other errors, rethrow immediately
        throw error;
      }
      logger.warn(`Rate limit hit for model ${model}, trying next model...`);
      if (model === SUMMARY_MODELS[SUMMARY_MODELS.length - 1]) {
        // Every model is rate limited — fail fast, the client decides when to retry
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(
          `Rate limit exceeded for all models. Please try again later. Original error: ${detail}`,
          { cause: error }
        );
      }
    }
  }

  if (!completion) {
    throw new Error(
      lastError instanceof Error && lastError.message
        ? lastError.message
        : 'OpenAI API did not return a response'
    );
  }

  // Defensive `?.` on message: the API has returned choices without one
  const summary = completion.choices[0]?.message?.content;

  if (!summary) {
    throw new Error('OpenAI API did not return a summary');
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
