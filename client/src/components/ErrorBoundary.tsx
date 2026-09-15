import type { ErrorInfo, ReactNode } from 'react';
import { Component } from 'react';
import i18n from '../i18n';
import { logError } from '../utils/logError';
import { Button } from './ui/Button';

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * Last line of defense for render errors: without a boundary, one throwing
 * component blanks the whole app. A class component is the only way React
 * lets you catch errors thrown during rendering.
 *
 * As a class it cannot use useTranslation, so it subscribes to
 * `languageChanged` by hand — otherwise the error screen would keep the
 * language from before the switch.
 */
export default class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  override componentDidMount(): void {
    i18n.on('languageChanged', this.handleLanguageChanged);
  }

  override componentWillUnmount(): void {
    i18n.off('languageChanged', this.handleLanguageChanged);
  }

  private handleLanguageChanged = (): void => {
    this.forceUpdate();
  };

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    logError({ message: 'ErrorBoundary caught a render error', error, componentStack: info.componentStack });
  }

  override render(): ReactNode {
    if (this.state.error !== null) {
      return (
        <div className="error-boundary">
          <h1>{i18n.t('app.unexpectedError')}</h1>
          <p>{this.state.error.message}</p>
          <Button onClick={() => window.location.reload()}>{i18n.t('app.refreshPage')}</Button>
        </div>
      );
    }
    return this.props.children;
  }
}
