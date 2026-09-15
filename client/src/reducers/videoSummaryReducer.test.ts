import { describe, expect, it } from 'vitest';
import type { VideoSummaryAction } from './videoSummaryReducer';
import { initialState, VideoSummaryActionType, videoSummaryReducer } from './videoSummaryReducer';

describe('videoSummaryReducer', () => {
  it('starts idle with no summary', () => {
    expect(initialState).toEqual({ summary: null, loading: false, error: null });
  });

  it('FETCH_SUMMARY_START clears a previous error', () => {
    const state = videoSummaryReducer(
      { summary: null, loading: false, error: 'rate limited' },
      { type: VideoSummaryActionType.FETCH_SUMMARY_START },
    );

    expect(state).toEqual({ summary: null, loading: true, error: null });
  });

  it('FETCH_SUMMARY_START keeps a summary already on screen', () => {
    const state = videoSummaryReducer(
      { summary: 'old summary', loading: false, error: null },
      { type: VideoSummaryActionType.FETCH_SUMMARY_START },
    );

    expect(state).toEqual({ summary: 'old summary', loading: true, error: null });
  });

  it('FETCH_SUMMARY_SUCCESS stores the text and stops loading', () => {
    const state = videoSummaryReducer(
      { summary: null, loading: true, error: null },
      { type: VideoSummaryActionType.FETCH_SUMMARY_SUCCESS, payload: 'A summary' },
    );

    expect(state).toEqual({ summary: 'A summary', loading: false, error: null });
  });

  it('FETCH_SUMMARY_ERROR stores the message and stops loading', () => {
    const state = videoSummaryReducer(
      { summary: null, loading: true, error: null },
      { type: VideoSummaryActionType.FETCH_SUMMARY_ERROR, payload: 'No subtitles found' },
    );

    expect(state).toEqual({ summary: null, loading: false, error: 'No subtitles found' });
  });

  it('RESET goes back to the initial state', () => {
    const state = videoSummaryReducer(
      { summary: 'A summary', loading: true, error: 'boom' },
      { type: VideoSummaryActionType.RESET },
    );

    expect(state).toEqual(initialState);
  });

  it('returns the same state for an unknown action', () => {
    const current = { summary: null, loading: false, error: null };
    const state = videoSummaryReducer(current, { type: 'NOPE' } as unknown as VideoSummaryAction);

    expect(state).toBe(current);
  });
});
