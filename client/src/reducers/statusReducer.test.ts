import { describe, expect, it } from 'vitest';
import type { StatusAction, StatusData } from './statusReducer';
import { initialState, StatusActionType, statusReducer } from './statusReducer';

const statusData: StatusData = {
  videosFolderPath: ['/videos/a'],
  folderConfigs: { '/videos/a': { channelUrl: 'https://yt/@a' } },
  downloadDefaults: { maxHeight: 2160, subLangs: ['en'], writeComments: true },
  indexedFolders: ['/videos/a'],
  listExists: { '/videos/a': false },
  status: 'ok',
};

describe('statusReducer', () => {
  it('starts loading with no data', () => {
    expect(initialState).toEqual({ statusData: null, loading: true, error: null });
  });

  it('FETCH_START clears a previous error and sets loading', () => {
    const state = statusReducer(
      { statusData: null, loading: false, error: 'boom' },
      { type: StatusActionType.FETCH_START },
    );

    expect(state).toEqual({ statusData: null, loading: true, error: null });
  });

  it('FETCH_START keeps data already on screen', () => {
    const state = statusReducer({ statusData, loading: false, error: null }, { type: StatusActionType.FETCH_START });

    expect(state.statusData).toBe(statusData);
    expect(state.loading).toBe(true);
  });

  it('FETCH_SUCCESS stores the payload and stops loading', () => {
    const state = statusReducer(initialState, {
      type: StatusActionType.FETCH_SUCCESS,
      payload: statusData,
    });

    expect(state).toEqual({ statusData, loading: false, error: null });
  });

  it('FETCH_ERROR stores the message and stops loading', () => {
    const state = statusReducer(initialState, {
      type: StatusActionType.FETCH_ERROR,
      payload: 'Service unavailable',
    });

    expect(state).toEqual({ statusData: null, loading: false, error: 'Service unavailable' });
  });

  it('FETCH_ERROR leaves previously loaded data in place', () => {
    const state = statusReducer(
      { statusData, loading: true, error: null },
      { type: StatusActionType.FETCH_ERROR, payload: 'HTTP 500' },
    );

    expect(state.statusData).toBe(statusData);
    expect(state.error).toBe('HTTP 500');
  });

  it('RESET goes back to the initial state', () => {
    const state = statusReducer({ statusData, loading: false, error: 'boom' }, { type: StatusActionType.RESET });

    expect(state).toEqual(initialState);
  });

  it('returns the same state for an unknown action', () => {
    const current = { statusData, loading: false, error: null };
    const state = statusReducer(current, { type: 'NOPE' } as unknown as StatusAction);

    expect(state).toBe(current);
  });
});
