import { useSyncExternalStore } from 'react';

/**
 * Whether Elasticsearch is reachable, as one small store instead of a context.
 *
 * Two things feed it: the `/health` poll (the banner owns that) and any API
 * answer that comes back with `code: 'elasticsearch_unavailable'`. The second
 * one matters because a user who hits search while the cluster is down should
 * see the banner in the same tick, not after the next poll.
 */

export type ElasticsearchState = 'unknown' | 'ok' | 'down';

let state: ElasticsearchState = 'unknown';
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) {
    listener();
  }
}

export function getElasticsearchState(): ElasticsearchState {
  return state;
}

/**
 * The health probe's verdict. It is the authority in both directions: it is
 * the check that also rebuilds the server's client, and the banner's retry
 * drives it.
 */
export function setElasticsearchState(next: ElasticsearchState): void {
  if (next === state) {
    return;
  }
  state = next;
  emit();
}

/** A request found the cluster unreachable (503, or a status that says so) */
export function reportElasticsearchUnavailable(): void {
  setElasticsearchState('down');
}

/**
 * A request found the cluster reachable. Only evidence, never a clearance: a
 * single status read must not hide the banner while the probe still says the
 * dependency is gone.
 */
export function reportElasticsearchReachable(): void {
  if (state !== 'down') {
    setElasticsearchState('ok');
  }
}

export function subscribeElasticsearchState(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Tests, and a page that wants to start from a clean slate */
export function resetElasticsearchState(): void {
  state = 'unknown';
  emit();
}

/** Reactive read of the store, without polling */
export function useElasticsearchState(): ElasticsearchState {
  return useSyncExternalStore(subscribeElasticsearchState, getElasticsearchState, getElasticsearchState);
}
