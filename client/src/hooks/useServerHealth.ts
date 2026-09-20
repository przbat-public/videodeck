import { HealthResponseSchema } from '@videodeck/shared/schemas';
import { useCallback, useEffect } from 'react';
import type { ElasticsearchState } from '../utils/elasticsearchStatus';
import { setElasticsearchState, useElasticsearchState } from '../utils/elasticsearchStatus';

/** How often the shell asks the readiness probe while the app is open */
const DEFAULT_POLL_MS = 10_000;

export interface UseServerHealthResult {
  /** Whether Elasticsearch answers; `unknown` while nothing has been checked */
  elasticsearch: ElasticsearchState;
  /** Ask right now (the banner's retry) */
  recheck: () => Promise<void>;
}

/**
 * Keeps the Elasticsearch state fresh: one `/health` poll, plus a check when
 * the window regains focus (the user comes back to the tab and wants to know if
 * it recovered). The answer lands in the small store so a failed request and
 * the menu read the same value.
 */
export function useServerHealth(pollIntervalMs = DEFAULT_POLL_MS): UseServerHealthResult {
  const elasticsearch = useElasticsearchState();

  const check = useCallback(async (): Promise<void> => {
    try {
      // /api/health, not /health: the dev proxy and nginx forward the API
      // prefix, and the raw path would land on the client's own index.html
      const response = await fetch('/api/health', { cache: 'no-store' });
      const parsed = HealthResponseSchema.safeParse(await response.json().catch(() => null));
      if (parsed.success) {
        setElasticsearchState(parsed.data.elasticsearch);
        return;
      }
      // An answer we cannot read is not evidence about the cluster
      setElasticsearchState('unknown');
    } catch {
      // The server itself is unreachable: the pages report that, and claiming
      // "Elasticsearch is down" would name the wrong cause
      setElasticsearchState('unknown');
    }
  }, []);

  useEffect(() => {
    void check();
    const timer = setInterval(() => {
      if (document.visibilityState !== 'hidden') {
        void check();
      }
    }, pollIntervalMs);
    const onFocus = (): void => {
      void check();
    };
    const onVisibility = (): void => {
      if (document.visibilityState === 'visible') {
        void check();
      }
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [check, pollIntervalMs]);

  return { elasticsearch, recheck: check };
}
