import type { JSX } from 'react';
import i18n from '../../i18n';

interface LoadingProps {
  message?: string;
}

/** Standard "loading" block used by every page */
export function Loading({ message }: LoadingProps): JSX.Element {
  return (
    <div className="ui-loading" role="status">
      <p>{message ?? i18n.t('app.loading')}</p>
    </div>
  );
}
