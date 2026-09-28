import { useSyncExternalStore } from 'react';
import type { LibraryState } from '../utils/libraryStatus';
import { getLibraryRevision, getLibraryState, subscribeLibraryState } from '../utils/libraryStatus';

/**
 * Reactive reads of the library store. The revision is what the data hooks
 * depend on: a page re-reads what it renders when the number moves, and it
 * never polls to find out that nothing did.
 */

export function useLibraryRevision(): number {
  return useSyncExternalStore(subscribeLibraryState, getLibraryRevision, getLibraryRevision);
}

export function useLibraryState(): LibraryState {
  return useSyncExternalStore(subscribeLibraryState, getLibraryState, getLibraryState);
}
