import { act, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import i18n from '../i18n';
import { libraryFrame } from '../test/libraryFrames';
import { applyLibraryFrame, clearLibraryArrivals, resetLibraryState } from '../utils/libraryStatus';
import { LibraryAnnouncer } from './LibraryAnnouncer';

/**
 * The live region has to be in the accessibility tree before its content
 * changes, so the first assertion is the one that matters: an empty region
 * exists, and the text lands in it later.
 */
describe('LibraryAnnouncer', () => {
  beforeEach(() => {
    resetLibraryState();
  });

  it('keeps an empty live region mounted and fills it when a drive arrives', () => {
    render(<LibraryAnnouncer />);

    const initial = screen.getByRole('status');
    expect(initial).toBeInTheDocument();
    expect(initial).toHaveTextContent('');

    act(() => {
      applyLibraryFrame(libraryFrame({ revision: 3, folders: ['/videos/a'] }));
      applyLibraryFrame(libraryFrame({ revision: 4, folders: ['/videos/a', '/videos/plugged-in'] }));
    });

    expect(screen.getByRole('status')).toHaveTextContent(i18n.t('library.detected', { count: 1 }));
  });

  it('goes quiet again once the notice is cleared', () => {
    render(<LibraryAnnouncer />);
    act(() => {
      applyLibraryFrame(libraryFrame({ revision: 3, folders: ['/videos/a'] }));
      applyLibraryFrame(libraryFrame({ revision: 4, folders: ['/videos/a', '/videos/plugged-in'] }));
    });

    act(() => {
      clearLibraryArrivals();
    });

    expect(screen.getByRole('status')).toHaveTextContent('');
  });
});
