import { timingSafeEqual } from 'node:crypto';
import type { ApiError } from '@videodeck/shared/api';
import type { NextFunction, Request, Response } from 'express';
import { logger } from '../utils/logger';
import { errnoCode, isRecord, readString } from '../utils/objectUtils';

// Generic narrowers live in utils/objectUtils.ts (services use them too);
// re-exported here so route code keeps a single `./http` import surface.
export { errnoCode, isRecord, readString };

/** Path-parameter type of routes without `:params` */
export type NoParams = Record<string, never>;

/**
 * Route handler with typed path params (`Params`) and JSON response body
 * (`Res`, or an `ApiError` on failure). The request body stays `unknown` and
 * the query keeps Express' `ParsedQs`: both come from the network and must be
 * narrowed (see the `read*` helpers) before use.
 */
export type RouteHandler<Params, Res> = (
  req: Request<Params, Res | ApiError, unknown>,
  res: Response<Res | ApiError>,
) => Promise<void> | void;

/** JSON object body of a request; an empty object for anything else */
export function readBody(req: { body: unknown }): Record<string, unknown> {
  return isRecord(req.body) ? req.body : {};
}

/**
 * Error response for a caught failure. The underlying `cause.message` is
 * logged, never sent: ENOENT messages carry absolute folder paths and
 * yt-dlp stderr tails can contain internal details — the same reason the
 * central error handler returns a generic 500 body.
 */
export function sendError<Res>(res: Response<Res | ApiError>, status: number, error: string, cause: unknown): void {
  logger.error(`${error}:`, cause instanceof Error ? cause.message : String(cause));
  res.status(status).json({ error });
}

/**
 * Whether a browser origin may call the API. Defaults: the local dev client
 * (localhost/127.0.0.1 on the known dev ports) and Chrome extensions (the
 * extension's background worker sends `Origin: chrome-extension://<id>`);
 * `extraOrigins` extends the list (CORS_ORIGINS env).
 *
 * Extension origins are open by default (unpacked dev extensions get a fresh
 * id per load). When `extensionOrigins` is set (EXTENSION_ORIGINS env), only
 * the exact listed ids are accepted.
 */
export function isAllowedCorsOrigin(
  origin: string,
  extraOrigins: readonly string[] = [],
  extensionOrigins: readonly string[] | undefined = undefined,
): boolean {
  if (extraOrigins.includes(origin)) {
    return true;
  }
  // Open-mode safety: any page served from ANY localhost port would be
  // same-site and could drive the API, so only the known client ports are
  // trusted. Other ports go through CORS_ORIGINS.
  if (/^https?:\/\/(localhost|127\.0\.0\.1):(3000|4173|5173)$/.test(origin)) {
    return true;
  }
  if (origin.startsWith('chrome-extension://')) {
    return extensionOrigins === undefined || extensionOrigins.includes(origin);
  }
  return false;
}

/** Constant-time comparison of a provided token against the configured one */
function tokenMatches(provided: string, expected: string): boolean {
  // No hashing: both sides are padded into equal-length buffers so
  // timingSafeEqual never leaks the configured token's length.
  const providedBytes = Buffer.from(provided, 'utf8');
  const expectedBytes = Buffer.from(expected, 'utf8');
  const length = Math.max(providedBytes.length, expectedBytes.length, 1);
  const providedBuffer = Buffer.alloc(length);
  const expectedBuffer = Buffer.alloc(length);
  providedBytes.copy(providedBuffer);
  expectedBytes.copy(expectedBuffer);
  return timingSafeEqual(providedBuffer, expectedBuffer);
}

/**
 * Guard for /api.
 *
 * With a configured token every request needs `Authorization: Bearer <token>`
 * (the Chrome extension sends it from its options). With `requireToken` the
 * open mode below is disabled entirely.
 *
 * Without a token the API stays open for non-browser clients (curl, the
 * server itself) and for the local web client, but browser requests coming
 * from other websites are rejected: browsers mark them with
 * `Sec-Fetch-Site: cross-site`, which stops a malicious page from driving
 * endpoints with side effects (reindex, queue, config writes) on localhost.
 * The Vite dev proxy forwards the client's `same-origin` marker untouched.
 */
export function createAuthMiddleware(
  token: string | undefined,
  requireToken = false,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    if (token) {
      const header = req.headers.authorization;
      const provided = header?.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : '';
      if (!tokenMatches(provided, token)) {
        res.status(401).json({ error: 'Unauthorized', message: 'Missing or invalid API token' });
        return;
      }
      next();
      return;
    }

    if (requireToken) {
      res.status(401).json({ error: 'Unauthorized', message: 'REQUIRE_API_TOKEN is set and API_TOKEN is missing' });
      return;
    }

    // Open mode: only browser cross-site requests are refused (CSRF guard).
    if (req.headers['sec-fetch-site'] === 'cross-site') {
      res.status(403).json({
        error: 'Forbidden',
        message: 'Cross-site requests are not allowed. Set API_TOKEN to allow remote clients.',
      });
      return;
    }
    next();
  };
}
