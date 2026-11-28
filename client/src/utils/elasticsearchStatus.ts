import { useSyncExternalStore } from 'react';

/**
 * Whether Elasticsearch is reachable, and whether it takes writes, as one
 * small store instead of a context.
 *
 * Two things feed the reachability: the `/health` poll (the banner owns that)
 * and any API answer that comes back with `code: 'elasticsearch_unavailable'`.
 * The second one matters because a user who hits search while the cluster is
 * down should see the banner in the same tick, not after the next poll. The
 * write refusal comes from the poll alone: a cluster that refuses writes still
 * answers every read.
 */

export type ElasticsearchState = 'unknown' | 'ok' | 'down';

let state: ElasticsearchState = 'unknown';
let writesRefused = false;
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

export function getWritesRefused(): boolean {
  return writesRefused;
}

/**
 * The health probe's verdict on writes: true while the cluster answers but
 * refuses them, as it does on a nearly full disk. Search keeps working then,
 * so the reachability is left alone.
 */
export function setWritesRefused(next: boolean): void {
  if (next === writesRefused) {
    return;
  }
  writesRefused = next;
  emit();
}

/** One subscription for both values: each reader compares its own snapshot */
export function subscribeElasticsearchState(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Tests, and a page that wants to start from a clean slate */
export function resetElasticsearchState(): void {
  state = 'unknown';
  writesRefused = false;
  emit();
}

/** Reactive read of the store, without polling */
export function useElasticsearchState(): ElasticsearchState {
  return useSyncExternalStore(subscribeElasticsearchState, getElasticsearchState, getElasticsearchState);
}

/** Reactive read of the write refusal, on the same subscription */
export function useWritesRefused(): boolean {
  return useSyncExternalStore(subscribeElasticsearchState, getWritesRefused, getWritesRefused);
}
