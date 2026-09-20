import { ApiErrorSchema, ELASTICSEARCH_UNAVAILABLE_CODE } from '@videodeck/shared/schemas';
import { reportElasticsearchUnavailable } from './elasticsearchStatus';

export interface ApiFailure {
  /** Server-supplied message; the contract guarantees the `error` field */
  message?: string;
  /** True when the answer said Elasticsearch cannot be reached */
  elasticsearchDown: boolean;
}

/**
 * Reads an error body once. A `503` with `code: 'elasticsearch_unavailable'`
 * is the server telling the client that a dependency is gone, not that the
 * request was wrong, so it also updates the health store: the banner appears in
 * the same tick as the failure instead of after the next poll.
 */
export async function readApiFailure(response: Response): Promise<ApiFailure> {
  const parsed = ApiErrorSchema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) {
    return { elasticsearchDown: false };
  }
  const elasticsearchDown = parsed.data.code === ELASTICSEARCH_UNAVAILABLE_CODE;
  if (elasticsearchDown) {
    reportElasticsearchUnavailable();
  }
  // `error` is required by the contract, so there is always something to show
  return { message: parsed.data.message ?? parsed.data.error, elasticsearchDown };
}
