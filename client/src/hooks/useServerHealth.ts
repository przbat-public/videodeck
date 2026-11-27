import { HealthResponseSchema } from '@videodeck/shared/schemas';
import { useCallback, useEffect, useState } from 'react';
import type { ElasticsearchState } from '../utils/elasticsearchStatus';
import { setElasticsearchState, useElasticsearchState } from '../utils/elasticsearchStatus';
import { applyLibraryRevision } from '../utils/libraryStatus';

/** How often the shell asks the readiness probe while the app is open */
const DEFAULT_POLL_MS = 10_000;

export interface UseServerHealthResult {
  /** Whether Elasticsearch answers; `unknown` while nothing has been checked */
  elasticsearch: ElasticsearchState;
  /**
   * True while the last probe said Elasticsearch answers but refuses writes,
   * as it does on a nearly full disk: search works, new videos miss it
   */
  writesRefused: boolean;
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
  // Only the banner reads it, so it stays here instead of in the store the
  // pages share: a refusal changes nothing about what they can ask for
  const [writesRefused, setWritesRefused] = useState(false);

  const check = useCallback(async (): Promise<void> => {
    try {
      // /api/health, not /health: the dev proxy and nginx forward the API
      // prefix, and the raw path would land on the client's own index.html
      const response = await fetch('/api/health', { cache: 'no-store' });
      const parsed = HealthResponseSchema.safeParse(await response.json().catch(() => null));
      if (parsed.success) {
        setElasticsearchState(parsed.data.elasticsearch);
        setWritesRefused(parsed.data.writes === 'refused');
        // The same answer carries the library revision, which is what keeps a
        // page honest when the event stream never opens: same signal, slower
        // road.
        applyLibraryRevision(parsed.data.revision);
        return;
      }
      // An answer we cannot read is not evidence about the cluster
      setElasticsearchState('unknown');
      setWritesRefused(false);
    } catch {
      // The server itself is unreachable: the pages report that, and claiming
      // "Elasticsearch is down" would name the wrong cause
      setElasticsearchState('unknown');
      setWritesRefused(false);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- mount fetch, the update lands after the await (see the rule note in eslint.config.mjs)
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

  return { elasticsearch, writesRefused, recheck: check };
}
