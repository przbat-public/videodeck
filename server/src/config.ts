import dotenv from 'dotenv';

dotenv.config();

const VIDEOS_FOLDER_PATH = process.env.VIDEOS_FOLDER_PATH as string;

if (!VIDEOS_FOLDER_PATH) {
  throw new Error('VIDEOS_FOLDER_PATH environment variable is required');
}

export const ELASTICSEARCH_URL = process.env.ELASTICSEARCH_URL || 'http://localhost:9200';

export const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

/** Bind address of the HTTP server. Loopback by default — see API_TOKEN. */
export const HOST = process.env.HOST || '127.0.0.1';

/**
 * Shared bearer token guarding /api. When unset the API is unauthenticated
 * (single-user local mode) and a warning is logged at startup.
 */
export const API_TOKEN = process.env.API_TOKEN;

/**
 * Extra browser origins allowed by CORS (comma-separated), on top of the
 * built-in defaults: the local dev client (localhost, any port) and Chrome
 * extensions.
 */
export const CORS_ORIGINS = process.env.CORS_ORIGINS;

/**
 * Get all video folder paths from environment variable
 * Supports multiple paths separated by semicolon (;) or comma (,)
 * @returns Array of folder paths
 */
export function getVideosFolderPaths(): string[] {
  // Support both semicolon and comma as separators
  const paths = VIDEOS_FOLDER_PATH.split(/[;,]/)
    .map((path) => path.trim())
    .filter((path) => path.length > 0);

  if (paths.length === 0) {
    throw new Error('VIDEOS_FOLDER_PATH must contain at least one valid folder path');
  }

  return paths;
}
