import type { LibraryEvent } from '@videodeck/shared/api';

/**
 * One frame of `GET /api/events`, for tests that move the library store the
 * way the stream does. The opening frame carries no added/removed, so the
 * default matches that; a test about a change passes them in.
 */
export function libraryFrame(overrides: Partial<LibraryEvent> = {}): LibraryEvent {
  return {
    type: 'library',
    revision: 1,
    folders: ['/videos/a'],
    unavailable: [],
    ...overrides,
  };
}
