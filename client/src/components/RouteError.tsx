import type { JSX } from 'react';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useRouteError } from 'react-router-dom';
import { logError } from '../utils/logError';

/**
 * Error element of the root route: covers both thrown route data and a lazy
 * page chunk that failed to load (offline, stale build). The render errors
 * themselves are still caught by ErrorBoundary above the router.
 */
export default function RouteError(): JSX.Element {
  const { t } = useTranslation();
  const error = useRouteError();
  // Logged in an effect: StrictMode double-invokes render, which used to
  // double-log every route error.
  useEffect(() => {
    logError({ message: 'Route error', error });
  }, [error]);

  return (
    <div className="route-error">
      <h1>{t('app.unexpectedError')}</h1>
      <p>{t('app.routeErrorText')}</p>
      <Link to="/">{t('app.backToStart')}</Link>
    </div>
  );
}
