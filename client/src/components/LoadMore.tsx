import type { JSX } from 'react';
import { useTranslation } from 'react-i18next';
import { useAutoLoadMore } from '../hooks/useAutoLoadMore';
import { Button } from './ui/Button';

interface LoadMoreProps {
  loading: boolean;
  /** The last page failed: wait for the button instead of retrying on every scroll */
  failed: boolean;
  onLoadMore: () => void;
}

/**
 * The end of a paged result list. Scrolling it into reach loads the next
 * page; the button stays for a retry after a failed page and for browsers
 * without IntersectionObserver.
 */
export function LoadMore({ loading, failed, onLoadMore }: LoadMoreProps): JSX.Element {
  const { t } = useTranslation();
  const endRef = useAutoLoadMore<HTMLDivElement>(onLoadMore, !(loading || failed));

  return (
    <div className="load-more" ref={endRef}>
      <Button onClick={onLoadMore} disabled={loading}>
        {loading ? t('app.loading') : t('search.loadMore')}
      </Button>
    </div>
  );
}
