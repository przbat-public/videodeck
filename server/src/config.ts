import dotenv from 'dotenv';

dotenv.config();

/**
 * Every value is read lazily (per call), so importing this module never
 * throws and never pins env values: the server validates at startup and
 * tests can set/clear the environment freely.
 */

export const ELASTICSEARCH_URL = process.env.ELASTICSEARCH_URL || 'http://localhost:9200';

/** Lazily read OpenAI key (only summaries need it) */
export function getOpenAiApiKey(): string | undefined {
  return process.env.OPENAI_API_KEY;
}

/** Bind address of the HTTP server. Loopback by default — see getApiToken. */
export function getHost(): string {
  return process.env.HOST || '127.0.0.1';
}

/**
 * Shared bearer token guarding /api. When unset the API is unauthenticated
 * (single-user local mode) and a warning is logged at startup.
 */
export function getApiToken(): string | undefined {
  return process.env.API_TOKEN;
}

/**
 * Extra browser origins allowed by CORS, on top of the built-in defaults:
 * the local dev client (localhost, any port) and Chrome extensions.
 */
export function getCorsOrigins(): string[] {
  return (process.env.CORS_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}

/**
 * Get all video folder paths from environment variable.
 * Supports multiple paths separated by semicolon (;) or comma (,).
 */
export function getVideosFolderPaths(): string[] {
  // Support both semicolon and comma as separators
  const paths = (process.env.VIDEOS_FOLDER_PATH ?? '')
    .split(/[;,]/)
    .map((path) => path.trim())
    .filter((path) => path.length > 0);

  if (paths.length === 0) {
    throw new Error('VIDEOS_FOLDER_PATH must contain at least one valid folder path');
  }

  return paths;
}
