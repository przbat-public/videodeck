import type { Request, Response } from 'express';
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
