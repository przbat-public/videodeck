import type { JSX, ReactNode } from 'react';

interface ErrorMessageProps {
  /** The error text (pages prefix it with the localized "error:" label) */
  children: ReactNode;
  /** Compact inline form for forms and lists; full-width block otherwise */
  compact?: boolean;
}

/** Standard error block: page-level banner or a compact form error */
export function ErrorMessage({ children, compact = false }: ErrorMessageProps): JSX.Element {
  return (
    <div className={compact ? 'ui-error-message ui-error-message--compact' : 'ui-error-message'} role="alert">
      <p>{children}</p>
    </div>
  );
}
