import type { JSX } from 'react';
import { useTranslation } from 'react-i18next';
import { useLibraryArrivals } from '../hooks/useLibrary';

/**
 * The announcement half of the arrival notice.
 *
 * A live region has to exist in the accessibility tree before its content
 * changes, or the change is never read out: `LibraryNotice` mounts its whole
 * strip together with the message, which is exactly the shape screen readers
 * ignore. This region is rendered by the shell on every page, stays empty
 * until a drive arrives, and carries the same sentence the strip shows.
 *
 * It is hidden visually, never with `display: none` or `visibility: hidden`,
 * which would take it out of the tree again.
 */
export function LibraryAnnouncer(): JSX.Element {
  const { t } = useTranslation();
  const arrivals = useLibraryArrivals();
  // The region is always in the tree; only its text changes, which is the shape
  // a screen reader announces. An empty string is the quiet state.
  const message = arrivals.length > 0 ? t('library.detected', { count: arrivals.length }) : '';

  return (
    <div className="library-announcer" role="status" aria-live="polite">
      {message}
    </div>
  );
}
