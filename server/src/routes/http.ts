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
 * Origins that may drive the API from a browser context, beyond the built-in
 * local client list: `CORS_ORIGINS` and, when set, the exact extension ids.
 */
export interface AuthMiddlewareOptions {
  extraOrigins?: readonly string[];
  extensionOrigins?: readonly string[] | undefined;
}

/** The request's Origin header, or an empty string when it has none */
function readOrigin(req: Request): string {
  const origin = req.headers.origin;
  return typeof origin === 'string' ? origin : '';
}

/**
 * Guard for /api.
 *
 * Browser requests are judged by the `Sec-Fetch-Site` marker first, in every
 * mode:
 * - `cross-site` is refused outright. A token does not change that: the nginx
 *   side injects the token into everything it proxies, so a request carrying
 *   it may still come from a page the operator never trusted.
 * - `same-site` (another port or subdomain on this host) is refused unless the
 *   `Origin` is on the trusted list, which is the local dev clients plus
 *   `CORS_ORIGINS` and the allowed extension ids.
 *
 * What is left for the token check: non-browser clients (curl, the server
 * itself) send no `Sec-Fetch-Site` at all.
 *
 * With a configured token every remaining request needs
 * `Authorization: Bearer <token>` (the Chrome extension sends it from its
 * options). With `requireToken` the open mode below is disabled entirely.
 * Without a token the API stays open for non-browser clients and for the local
 * web client.
 */
export function createAuthMiddleware(
  token: string | undefined,
  requireToken = false,
  options: AuthMiddlewareOptions = {},
): (req: Request, res: Response, next: NextFunction) => void {
  const extraOrigins = options.extraOrigins ?? [];
  return (req, res, next) => {
    const site = req.headers['sec-fetch-site'];
    if (site === 'cross-site') {
      res.status(403).json({
        error: 'Forbidden',
        message: 'Cross-site requests are not allowed.',
      });
      return;
    }
    if (site === 'same-site' && !isAllowedCorsOrigin(readOrigin(req), extraOrigins, options.extensionOrigins)) {
      res.status(403).json({
        error: 'Forbidden',
        message: 'Requests from another origin on this host are not allowed. List yours in CORS_ORIGINS.',
      });
      return;
    }

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

    next();
  };
}
