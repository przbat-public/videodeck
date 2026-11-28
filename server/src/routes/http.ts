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
 * Origins and hosts that may drive the API from a browser context, beyond
 * the built-in local client list: `CORS_ORIGINS`, the exact extension ids
 * when set, and the `ALLOWED_HOSTS` names, whose pages may post where the
 * browser sends no `Sec-Fetch-Site`.
 */
export interface AuthMiddlewareOptions {
  extraOrigins?: readonly string[];
  extensionOrigins?: readonly string[] | undefined;
  allowedHosts?: readonly string[];
}

/** The request's Origin header, or an empty string when it has none */
function readOrigin(req: Request): string {
  const origin = req.headers.origin;
  return typeof origin === 'string' ? origin : '';
}

/** Names that, in an Origin, mean a page on the browser's own machine */
const LOOPBACK_HOSTNAMES: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '::1']);

/** A hostname lowercased, without the brackets an IPv6 literal carries in a URL */
function bareHostname(host: string): string {
  return host.toLowerCase().replace(/^\[(.*)\]$/, '$1');
}

/** The name in a Host-style value ("nas.local:3000", "[::1]:8080"): lowercased, no port, no brackets */
function hostnameOf(authority: string): string {
  const lower = authority.toLowerCase();
  return lower.startsWith('[') ? lower.replace(/^\[(.*)\](:\d+)?$/, '$1') : lower.replace(/:\d+$/, '');
}

/**
 * The address the browser used for this request: the first X-Forwarded-Host
 * value (nginx passes on the Host it received), else the Host header. The
 * forwarded value counts only when its name is one the Host guard in app.ts
 * accepts, loopback or an ALLOWED_HOSTS entry: a proxy that sets Host to an
 * address of its own hides a rebinding page's name from that guard, and the
 * page would otherwise pass here by sending that name as its Origin. It reads
 * the raw headers, never req.host, so TRUST_PROXY cannot change the answer. A
 * page cannot set X-Forwarded-Host without a preflight, which CORS answers
 * without an Allow-Origin, and nginx overwrites it.
 */
function requestAuthority(req: Request, allowedHosts: readonly string[]): string {
  const host = (req.headers.host ?? '').toLowerCase();
  const forwarded = readString(req.headers['x-forwarded-host'])?.split(',')[0]?.trim().toLowerCase();
  if (!forwarded) {
    return host;
  }
  const name = hostnameOf(forwarded);
  const known = LOOPBACK_HOSTNAMES.has(name) || allowedHosts.some((allowed) => bareHostname(allowed) === name);
  return known ? forwarded : host;
}

/**
 * Whether a browser request without `Sec-Fetch-Site` may go on, judged by its
 * Origin. Browsers leave the marker out for a plain-HTTP address that is not
 * loopback, which is how a LAN deploy is reached, so there:
 * - no Origin passes (curl, the server itself, a same-origin GET), and the
 *   token decides;
 * - `null` or an Origin that does not parse is refused;
 * - a trusted origin passes (the dev clients, `CORS_ORIGINS`, the allowed
 *   extension ids);
 * - an Origin naming the address the browser used (requestAuthority) passes:
 *   the UI's own page;
 * - an Origin on an `ALLOWED_HOSTS` host passes on any port, unless the name
 *   is a loopback one, which in an Origin means the browser's own machine.
 */
export function isTrustedUnmarkedOrigin(
  origin: string,
  authority: string,
  options: AuthMiddlewareOptions = {},
): boolean {
  if (origin === '') {
    return true;
  }
  if (origin === 'null') {
    return false;
  }
  if (isAllowedCorsOrigin(origin, options.extraOrigins ?? [], options.extensionOrigins)) {
    return true;
  }
  const url = URL.parse(origin);
  if (url === null) {
    return false;
  }
  if (url.host === authority) {
    return true;
  }
  const hostname = bareHostname(url.hostname);
  return (
    !LOOPBACK_HOSTNAMES.has(hostname) && (options.allowedHosts ?? []).some((host) => bareHostname(host) === hostname)
  );
}

/** What the guard for /api answers a request: let it through, or refuse it with this status and body */
export type AuthDecision = { allowed: true } | { allowed: false; status: 401 | 403; body: ApiError };

/** The guard's decision for one request, taken from its headers alone */
export type Authorizer = (req: Request) => AuthDecision;

const ALLOWED: AuthDecision = { allowed: true };

function refuse(status: 401 | 403, error: string, message: string): AuthDecision {
  return { allowed: false, status, body: { error, message } };
}

const UNMARKED_ORIGIN_REFUSAL =
  'Requests from another origin are not allowed. List its host in ALLOWED_HOSTS or the origin in CORS_ORIGINS.';

/** An extension is refused only when EXTENSION_ORIGINS is set without its id */
const EXTENSION_ORIGIN_REFUSAL = 'Requests from this extension are not allowed. List its origin in EXTENSION_ORIGINS.';

/**
 * The refusal a browser request earns by where it comes from, or null. The
 * marked verdicts come first and stay as they were: cross-site whatever the
 * Origin, then a same-site Origin off the trusted list. A request without the
 * marker is judged by its Origin (isTrustedUnmarkedOrigin); `same-origin` and
 * `none` pass.
 */
function refuseByOrigin(req: Request, options: AuthMiddlewareOptions): AuthDecision | null {
  const site = req.headers['sec-fetch-site'];
  const origin = readOrigin(req);
  if (site === 'cross-site') {
    return refuse(403, 'Forbidden', 'Cross-site requests are not allowed.');
  }
  if (site === 'same-site' && !isAllowedCorsOrigin(origin, options.extraOrigins ?? [], options.extensionOrigins)) {
    return refuse(
      403,
      'Forbidden',
      'Requests from another origin on this host are not allowed. List yours in CORS_ORIGINS.',
    );
  }
  if (
    site === undefined &&
    !isTrustedUnmarkedOrigin(origin, requestAuthority(req, options.allowedHosts ?? []), options)
  ) {
    const extension = origin.startsWith('chrome-extension://');
    return refuse(403, 'Forbidden', extension ? EXTENSION_ORIGIN_REFUSAL : UNMARKED_ORIGIN_REFUSAL);
  }
  return null;
}

/**
 * The decision of the guard for /api. createAuthMiddleware answers with it,
 * and the rate limit asks it before a media read may skip the count (app.ts),
 * so the two cannot disagree on which requests get through.
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
 * - no marker at all, which is what a browser sends a plain-HTTP address that
 *   is not loopback: the `Origin` decides (isTrustedUnmarkedOrigin), so a
 *   foreign page cannot send a write to a LAN deploy with the token nginx
 *   adds. A link or an image sends no Origin, and its GET goes on to the
 *   token like curl's.
 *
 * A request without an Origin (curl, the server itself) goes on to the token.
 *
 * With a configured token every remaining request needs
 * `Authorization: Bearer <token>` (the Chrome extension sends it from its
 * options). With `requireToken` the open mode below is disabled entirely.
 * Without a token the API stays open for non-browser clients and for the local
 * web client.
 */
export function createAuthorizer(
  token: string | undefined,
  requireToken = false,
  options: AuthMiddlewareOptions = {},
): Authorizer {
  return (req) => {
    const refusal = refuseByOrigin(req, options);
    if (refusal !== null) {
      return refusal;
    }

    if (token) {
      const header = req.headers.authorization;
      const provided = header?.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : '';
      return tokenMatches(provided, token) ? ALLOWED : refuse(401, 'Unauthorized', 'Missing or invalid API token');
    }

    if (requireToken) {
      return refuse(401, 'Unauthorized', 'REQUIRE_API_TOKEN is set and API_TOKEN is missing');
    }

    return ALLOWED;
  };
}

/** Guard for /api: passes on what `authorize` allows and answers its refusal otherwise */
export function createAuthMiddleware(authorize: Authorizer): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    const decision = authorize(req);
    if (decision.allowed) {
      next();
      return;
    }
    res.status(decision.status).json(decision.body);
  };
}
