import { describe, expect, it } from 'vitest';
import type { RecreateIndicesAction } from './recreateIndicesReducer';
import { initialState, RecreateIndicesActionType, recreateIndicesReducer } from './recreateIndicesReducer';

describe('recreateIndicesReducer', () => {
  it('starts idle with no message', () => {
    expect(initialState).toEqual({ loading: false, message: null });
  });

  it('RECREATE_START drops the previous message', () => {
    const state = recreateIndicesReducer(
      { loading: false, message: { type: 'error', text: 'boom' } },
      { type: RecreateIndicesActionType.RECREATE_START },
    );

    expect(state).toEqual({ loading: true, message: null });
  });

  it('RECREATE_SUCCESS reports success and stops loading', () => {
    const state = recreateIndicesReducer(
      { loading: true, message: null },
      { type: RecreateIndicesActionType.RECREATE_SUCCESS, payload: '2561 videos indexed' },
    );

    expect(state).toEqual({
      loading: false,
      message: { type: 'success', text: '2561 videos indexed' },
    });
  });

  it('RECREATE_ERROR reports failure and stops loading', () => {
    const state = recreateIndicesReducer(
      { loading: true, message: null },
      { type: RecreateIndicesActionType.RECREATE_ERROR, payload: 'Elasticsearch unreachable' },
    );

    expect(state).toEqual({
      loading: false,
      message: { type: 'error', text: 'Elasticsearch unreachable' },
    });
  });

  it('CLEAR_MESSAGE removes the message but leaves loading alone', () => {
    const state = recreateIndicesReducer(
      { loading: true, message: { type: 'success', text: 'done' } },
      { type: RecreateIndicesActionType.CLEAR_MESSAGE },
    );

    expect(state).toEqual({ loading: true, message: null });
  });

  it('returns the same state for an unknown action', () => {
    const current = { loading: false, message: null };
    const state = recreateIndicesReducer(current, {
      type: 'NOPE',
    } as unknown as RecreateIndicesAction);

    expect(state).toBe(current);
  });
});
