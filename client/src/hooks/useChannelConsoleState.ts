import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { ChannelConsoleState } from '../utils/channelConsoleState';
import { parseChannelConsoleState, toChannelConsoleParams } from '../utils/channelConsoleState';

export interface UseChannelConsoleStateResult {
  /** What the URL currently says — the single source of truth for the page */
  state: ChannelConsoleState;
  /**
   * Writes the state to the URL, replacing the current entry: a filter change
   * or an expanded row must not fill the history with steps the Back button
   * has to walk through.
   */
  setState: (next: ChannelConsoleState) => void;
}

/** The console's filter, sort and expanded row, kept in the URL */
export function useChannelConsoleState(): UseChannelConsoleStateResult {
  const [searchParams, setSearchParams] = useSearchParams();

  const state = useMemo(() => parseChannelConsoleState(searchParams), [searchParams]);

  const setState = useCallback(
    (next: ChannelConsoleState) => {
      setSearchParams(toChannelConsoleParams(next), { replace: true });
    },
    [setSearchParams],
  );

  return { state, setState };
}
