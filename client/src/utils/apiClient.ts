import i18n from '../i18n';
import type { ApiFailure } from './apiFailure';
import { readApiFailure } from './apiFailure';

/** The slice of a zod schema this module needs, so the client keeps no zod dependency of its own */
export interface ResponseSchema<T> {
  parse: (body: unknown) => T;
}

export type ApiSendMethod = 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** Generic wording for a failed request when the server sent none of its own */
const GENERIC_FAILURE_KEY = 'errors.occurred';

export interface ApiRequestOptions {
  /** Abort signal handed straight to `fetch` */
  signal?: AbortSignal;
  /** `cache` mode; the endpoints this client polls pass `no-store` so a 304 cannot read as a failure */
  cache?: RequestCache;
  /**
   * Fixed wording for a non-ok answer: a string, or a function of the status.
   * The answer body is not read, so the wording is the whole story.
   */
  message?: string | ((status: number) => string);
  /**
   * Wording built from the server's own failure. Reading the answer also tells
   * the health store that Elasticsearch is gone, so the banner shows up in the
   * same tick as the failure instead of after the next poll.
   */
  failureMessage?: (failure: ApiFailure, status: number) => string;
}

/** A request the server answered with a non-ok status */
export class ApiRequestError extends Error {
  readonly status: number;
  readonly elasticsearchDown: boolean;

  constructor(message: string, status: number, elasticsearchDown: boolean) {
    super(message);
    this.name = 'ApiRequestError';
    this.status = status;
    this.elasticsearchDown = elasticsearchDown;
  }
}

/**
 * Builds the fetch init, or undefined when the request needs none: a bare
 * `fetch(path)` is what the simplest call sites have always sent.
 */
function requestInit(
  method: ApiSendMethod | undefined,
  body: unknown,
  options: ApiRequestOptions,
): RequestInit | undefined {
  const init: RequestInit = {};
  if (method !== undefined) {
    init.method = method;
  }
  if (body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  if (options.cache !== undefined) {
    init.cache = options.cache;
  }
  if (options.signal !== undefined) {
    init.signal = options.signal;
  }
  return Object.keys(init).length > 0 ? init : undefined;
}

/** The error a non-ok answer becomes */
async function failureError(response: Response, options: ApiRequestOptions): Promise<ApiRequestError> {
  if (options.failureMessage !== undefined) {
    const failure = await readApiFailure(response);
    return new ApiRequestError(
      options.failureMessage(failure, response.status),
      response.status,
      failure.elasticsearchDown,
    );
  }
  if (options.message !== undefined) {
    const message = typeof options.message === 'function' ? options.message(response.status) : options.message;
    return new ApiRequestError(message, response.status, false);
  }
  const failure = await readApiFailure(response);
  return new ApiRequestError(
    failure.message ?? i18n.t(GENERIC_FAILURE_KEY),
    response.status,
    failure.elasticsearchDown,
  );
}

/** GET `path` and read the answer with `schema` */
export async function apiGet<T>(path: string, schema: ResponseSchema<T>, options: ApiRequestOptions = {}): Promise<T> {
  const init = requestInit(undefined, undefined, options);
  const response = init === undefined ? await fetch(path) : await fetch(path, init);
  if (!response.ok) {
    throw await failureError(response, options);
  }
  return schema.parse(await response.json());
}

/** Sends a body and reads the answer with `schema` */
export function apiSend<T>(
  method: ApiSendMethod,
  path: string,
  schema: ResponseSchema<T>,
  body?: unknown,
  options?: ApiRequestOptions,
): Promise<T>;
/** Sends a request whose answer body does not matter: a 2xx answer is the whole outcome */
export function apiSend(
  method: ApiSendMethod,
  path: string,
  schema: null,
  body?: unknown,
  options?: ApiRequestOptions,
): Promise<void>;
export async function apiSend<T>(
  method: ApiSendMethod,
  path: string,
  schema: ResponseSchema<T> | null,
  body?: unknown,
  options: ApiRequestOptions = {},
): Promise<T | undefined> {
  const response = await fetch(path, requestInit(method, body, options));
  if (!response.ok) {
    throw await failureError(response, options);
  }
  if (schema === null) {
    return undefined;
  }
  return schema.parse(await response.json());
}
