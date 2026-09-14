import type { NextFunction, Request, Response } from 'express';
import type { ApiError } from '@shared/api';

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
  res: Response<Res | ApiError>
) => Promise<void> | void;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** JSON object body of a request; an empty object for anything else */
export function readBody(req: { body: unknown }): Record<string, unknown> {
  return isRecord(req.body) ? req.body : {};
}

/** `value` when it is a non-empty string (query values may also be arrays) */
export function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Error response with the message of the underlying cause */
export function sendError<Res>(
  res: Response<Res | ApiError>,
  status: number,
  error: string,
  cause: unknown
): void {
  res.status(status).json({
    error,
    message: cause instanceof Error ? cause.message : 'Unknown error',
  });
}

/** `code` of a Node.js filesystem error, when the value is one */
export function errnoCode(error: unknown): string | undefined {
  return isRecord(error) && typeof error.code === 'string' ? error.code : undefined;
}

/**
 * Whether a browser origin may call the API. Defaults: the local dev client
 * (localhost/127.0.0.1, any port) and Chrome extensions (the extension's
 * background worker sends `Origin: chrome-extension://<id>`); `extraOrigins`
 * extends the list (CORS_ORIGINS env).
 */
export function isAllowedCorsOrigin(origin: string, extraOrigins: readonly string[] = []): boolean {
  if (extraOrigins.includes(origin)) {
    return true;
  }
  return (
    /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin) ||
    origin.startsWith('chrome-extension://')
  );
}

/**
 * Guard for /api.
 *
 * With a configured token every request needs `Authorization: Bearer <token>`
 * (the Chrome extension sends it from its options).
 *
 * Without a token the API stays open for non-browser clients (curl, the
 * server itself) and for the local web client, but browser requests coming
 * from other websites are rejected: browsers mark them with
 * `Sec-Fetch-Site: cross-site`, which stops a malicious page from driving
 * endpoints with side effects (reindex, queue, config writes) on localhost.
 * The Vite dev proxy forwards the client's `same-origin` marker untouched.
 */
export function createAuthMiddleware(
  token: string | undefined
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    if (token) {
      const header = req.headers.authorization;
      const provided = header?.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : '';
      if (provided !== token) {
        res.status(401).json({ error: 'Unauthorized', message: 'Missing or invalid API token' });
        return;
      }
      next();
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
