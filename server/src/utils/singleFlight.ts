/**
 * One in-flight pass per key.
 *
 * Two callers that ask for the same thing at the same moment share the work
 * instead of doing it twice: the second gets the first one's promise. The entry
 * is dropped the moment it settles, so a later caller starts fresh, and a
 * rejection is never cached — a failure is answered to whoever asked for it and
 * the next caller tries again.
 *
 * This is deliberately not a cache. The routes that use it keep their own TTL
 * cache; this only closes the window between "no cached body" and "body built",
 * which is exactly the window two browser tabs land in.
 */
export interface SingleFlight<K, V> {
  run(key: K, load: () => Promise<V>): Promise<V>;
}

export function createSingleFlight<K, V>(): SingleFlight<K, V> {
  const inFlight = new Map<K, Promise<V>>();
  return {
    run(key: K, load: () => Promise<V>): Promise<V> {
      const running = inFlight.get(key);
      if (running !== undefined) {
        return running;
      }
      const started = load().finally(() => {
        inFlight.delete(key);
      });
      inFlight.set(key, started);
      return started;
    },
  };
}
