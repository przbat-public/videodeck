import dotenv from 'dotenv';
import { getLibrarySnapshot, parseLibraryRoots, resetLibraryState } from './services/libraryState';

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

/**
 * Endpoint the OpenAI SDK talks to. Unset keeps the SDK default; the deep
 * server integration points it at the in-process mock instead.
 */
export function getOpenAiBaseUrl(): string | undefined {
  const raw = (process.env.OPENAI_BASE_URL ?? '').trim();
  return raw.length > 0 ? raw : undefined;
}

/**
 * The provider named by the operator, when set. `validateEnv` rejects any
 * other value at boot, so an unknown string here means a test set it and the
 * resolver falls back to the key that is present.
 */
export function getSummaryProviderOverride(): 'openai' | 'deepseek' | undefined {
  const raw = (process.env.SUMMARY_PROVIDER ?? '').trim().toLowerCase();
  return raw === 'openai' || raw === 'deepseek' ? raw : undefined;
}

/** Lazily read DeepSeek key (only summaries need it) */
export function getDeepSeekApiKey(): string | undefined {
  return process.env.DEEPSEEK_API_KEY;
}

/**
 * Raw `DEEPSEEK_MODEL`: a model name, optionally suffixed with the reasoning
 * effort as `name:effort`. llmProviders parses it and owns the default.
 */
export function getDeepSeekModel(): string | undefined {
  const raw = (process.env.DEEPSEEK_MODEL ?? '').trim();
  return raw.length > 0 ? raw : undefined;
}

/** DeepSeek endpoint; unset leaves the provider default to llmProviders */
export function getDeepSeekBaseUrl(): string | undefined {
  const raw = (process.env.DEEPSEEK_BASE_URL ?? '').trim();
  return raw.length > 0 ? raw : undefined;
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
 * When true, open mode is refused: without API_TOKEN every request is 401.
 * Recommended whenever OPENAI_API_KEY is set (summaries cost money) or the
 * server listens on a non-loopback HOST.
 */
export function isTokenRequired(): boolean {
  return process.env.REQUIRE_API_TOKEN === 'true';
}

/**
 * Extra browser origins allowed by CORS, on top of the built-in defaults:
 * the local dev client (localhost on the known dev ports) and Chrome
 * extensions.
 */
export function getCorsOrigins(): string[] {
  return (process.env.CORS_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}

/**
 * Extra hosts accepted in the `Host` header, on top of the loopback defaults
 * (localhost, 127.0.0.1, [::1]). Needed together with `HOST=0.0.0.0` for LAN
 * use: every name/IP the clients will use must be listed, or the server
 * answers 403. This is the DNS-rebinding guard — a malicious domain resolving
 * to 127.0.0.1 sends its own Host header and gets refused.
 */
export function getAllowedHosts(): string[] {
  return (process.env.ALLOWED_HOSTS ?? '')
    .split(',')
    .map((host) => host.trim())
    .filter((host) => host.length > 0);
}

/**
 * Exact `chrome-extension://<id>` origins allowed by CORS. When unset,
 * any Chrome extension may call the API (dev convenience: unpacked
 * extensions get a fresh id per load). When set, only the listed ids can —
 * e.g. `EXTENSION_ORIGINS=chrome-extension://abcdefghijklmnop` after pinning
 * the extension id.
 */
export function getExtensionOrigins(): string[] | undefined {
  const raw = process.env.EXTENSION_ORIGINS ?? '';
  const origins = raw
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
  return origins.length > 0 ? origins : undefined;
}

/**
 * Rate limit for the whole HTTP server (requests per window per IP).
 * Generous by default: the client polls the queue every 1.5 s while jobs
 * run. `RATE_LIMIT_MAX`/`RATE_LIMIT_WINDOW_MS` override.
 */
export function getRateLimitMax(): number {
  const parsed = Number.parseInt(process.env.RATE_LIMIT_MAX ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 2000;
}

export function getRateLimitWindowMs(): number {
  const parsed = Number.parseInt(process.env.RATE_LIMIT_WINDOW_MS ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 10 * 60 * 1000;
}

/**
 * How many proxies in front of the server are trusted for the client IP
 * (`app.set('trust proxy', …)`). The rate limit counts per IP, and behind the
 * nginx container every request arrives from the proxy: without this the whole
 * household shares one bucket, and with a too-wide setting a client can spoof
 * its address with `X-Forwarded-For`.
 *
 * `TRUST_PROXY` accepts a hop count (`1` for the single nginx hop of the
 * shipped compose stack), `loopback`, a subnet, or `false`. Unset means "trust
 * nobody", which is right when the server is reached directly. A bare `true` is
 * refused: it trusts every hop, which turns the rate-limit key into a header
 * the client picks, and express-rate-limit flags the value as permissive.
 */
export function getTrustProxy(): string | number | boolean | undefined {
  const raw = (process.env.TRUST_PROXY ?? '').trim();
  if (raw.length === 0) {
    return undefined;
  }
  if (raw.toLowerCase() === 'true') {
    throw new Error(
      'TRUST_PROXY=true trusts every hop, so a client can pick its own rate-limit key with X-Forwarded-For. ' +
        'Set the number of proxies in front of the server (1 for the shipped compose stack), false, loopback or a subnet.',
    );
  }
  if (raw === 'false') {
    return false;
  }
  const hops = Number.parseInt(raw, 10);
  return Number.isInteger(hops) && String(hops) === raw ? hops : raw;
}

// ---------------------------------------------------------------------------
// Video folders
// ---------------------------------------------------------------------------

/**
 * Get all video folder paths from `VIDEOS_FOLDER_PATH`.
 *
 * Entries are separated by `;` or `,`, `~/` is expanded, and an entry may be
 * a glob pattern (segment-level `*`, e.g. `/Volumes/<disk>/<channel>`) that
 * is expanded to the channel folders that currently exist. This solves the
 * swappable-drive pain: one env line covers every drive, and a drive that is
 * not mounted simply contributes no folders instead of failing validation.
 *
 * The list itself lives in `services/libraryState`, which owns the snapshot,
 * watches the roots and rescans them while the process runs; this reads the
 * current snapshot instead of caching a scan, so a drive mounted a second ago
 * is already in the list. The raw value is still read on every call, and a
 * changed value is rebuilt on the spot. A pattern that matches nothing right
 * now yields an empty list with a warning (logged by the snapshot publish),
 * never a hard error, so the server still boots without the drive and picks
 * folders up once it appears. An empty VIDEOS_FOLDER_PATH still throws.
 */
export function getVideosFolderPaths(): string[] {
  const raw = process.env.VIDEOS_FOLDER_PATH ?? '';
  if (parseLibraryRoots(raw).length === 0) {
    throw new Error('VIDEOS_FOLDER_PATH must contain at least one valid folder path');
  }
  return [...getLibrarySnapshot().folders];
}

/**
 * Forget the library snapshot (tests, config reloads). The watcher stays
 * armed; the next read rebuilds the list from the current environment.
 */
export function invalidateVideosFolderCache(): void {
  resetLibraryState();
}
