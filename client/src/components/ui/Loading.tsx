import type { JSX } from 'react';
import { useTranslation } from 'react-i18next';

interface LoadingProps {
  message?: string;
}

/** Standard "loading" block used by every page */
export function Loading({ message }: LoadingProps): JSX.Element {
  const { t } = useTranslation();
  return (
    <div className="ui-loading" role="status">
      <p>{message ?? t('app.loading')}</p>
    </div>
  );
}
