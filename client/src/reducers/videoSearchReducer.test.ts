import type { VideoListItem } from '@videodeck/shared/api';
import { SEARCH_DEFAULT_PAGE_SIZE } from '@videodeck/shared/schemas';
import { describe, expect, it } from 'vitest';
import type { VideoSearchAction } from './videoSearchReducer';
import { initialState, VideoSearchActionType, videoSearchReducer } from './videoSearchReducer';

/** Rows the window keeps, whatever the number of pages loaded */
const WINDOW_ROWS = 2 * SEARCH_DEFAULT_PAGE_SIZE;

/** A page of `count` rows starting at `start`, each titled after its position */
const rows = (start: number, count: number): VideoListItem[] =>
  Array.from({ length: count }, (_, index) => ({
    baseName: `video-${start + index}`,
    title: `Video ${start + index}`,
    description: 'A description',
    videoPath: `video-${start + index}.mp4`,
    thumbnailPath: `video-${start + index}.webp`,
    folderPath: '/videos',
    comments: [],
  }));

const pageLoaded = (videos: VideoListItem[], totalCount: number, append = false): VideoSearchAction => ({
  type: VideoSearchActionType.SEARCH_SUCCESS,
  payload: { videos, totalCount, ...(append ? { append: true } : {}) },
});

describe('videoSearchReducer', () => {
  it('starts with an empty window and nothing loaded', () => {
    expect(initialState).toEqual({
      videos: [],
      loadedCount: 0,
      totalCount: 0,
      loading: false,
      loadingMore: false,
      error: null,
    });
  });

  it('appends a page and counts every row the server has handed over', () => {
    const first = videoSearchReducer(initialState, pageLoaded(rows(0, 100), 230));
    const second = videoSearchReducer(first, pageLoaded(rows(100, 100), 230, true));

    expect(second.videos).toEqual([...rows(0, 100), ...rows(100, 100)]);
    expect(second.loadedCount).toBe(200);
    expect(second.totalCount).toBe(230);
    expect(second.loading).toBe(false);
  });

  it('releases the oldest rows once the window is full, so its size stops growing with the pages loaded', () => {
    // Twelve pages in: a long scroll must not leave 1200 rows, and the cards
    // they render, in memory however far the user goes.
    let state = initialState;
    for (let page = 0; page < 12; page += 1) {
      const start = page * SEARCH_DEFAULT_PAGE_SIZE;
      state = videoSearchReducer(
        state,
        pageLoaded(rows(start, SEARCH_DEFAULT_PAGE_SIZE), 12 * SEARCH_DEFAULT_PAGE_SIZE, page > 0),
      );
    }

    expect(state.videos).toHaveLength(WINDOW_ROWS);
    expect(state.videos.some((video) => video.title === 'Video 0')).toBe(false);
    // The window holds the rows loaded last: the ones around the position the
    // user scrolled to.
    expect(state.videos.at(0)?.title).toBe(`Video ${12 * SEARCH_DEFAULT_PAGE_SIZE - WINDOW_ROWS}`);
    expect(state.videos.at(-1)?.title).toBe(`Video ${12 * SEARCH_DEFAULT_PAGE_SIZE - 1}`);
    // The count still knows where the result set stands, so the next page asks
    // for the rows after everything loaded instead of the rows on screen.
    expect(state.loadedCount).toBe(12 * SEARCH_DEFAULT_PAGE_SIZE);
  });

  it('keeps the window and its count when a load more fails', () => {
    const loaded = videoSearchReducer(initialState, pageLoaded(rows(0, 100), 300));

    const failed = videoSearchReducer(loaded, {
      type: VideoSearchActionType.SEARCH_ERROR,
      payload: { message: 'Network error', append: true },
    });

    expect(failed.videos).toEqual(rows(0, 100));
    expect(failed.loadedCount).toBe(100);
    expect(failed.totalCount).toBe(300);
    expect(failed.error).toBe('Network error');
  });

  it('empties the window and its count when a fresh search fails', () => {
    const loaded = videoSearchReducer(initialState, pageLoaded(rows(0, 100), 300));

    const failed = videoSearchReducer(loaded, {
      type: VideoSearchActionType.SEARCH_ERROR,
      payload: { message: 'Network error' },
    });

    expect(failed).toMatchObject({ videos: [], loadedCount: 0, totalCount: 0, error: 'Network error' });
  });

  it('starts a new window when a fresh search lands', () => {
    const loaded = videoSearchReducer(initialState, pageLoaded(rows(0, 100), 1200, true));

    const fresh = videoSearchReducer(loaded, pageLoaded(rows(500, 100), 620));

    expect(fresh.videos).toEqual(rows(500, 100));
    expect(fresh.loadedCount).toBe(100);
    expect(fresh.totalCount).toBe(620);
  });
});
