import type { JSX, ReactNode } from 'react';

type ButtonVariant = 'neutral' | 'primary' | 'success' | 'danger';

interface ButtonProps {
  onClick?: () => void;
  disabled?: boolean;
  title?: string;
  type?: 'button' | 'submit';
  variant?: ButtonVariant;
  size?: 'default' | 'small';
  /** Extra classes for layout (the variant covers the look) */
  className?: string;
  children: ReactNode;
}

/**
 * Reusable button with the app's four visual roles. Handlers that return a
 * promise are wrapped by the call sites (`onClick={() => void load()}`), so
 * the component itself stays synchronous.
 */
export function Button({
  onClick,
  disabled = false,
  title,
  type = 'button',
  variant = 'neutral',
  size = 'default',
  className = '',
  children,
}: ButtonProps): JSX.Element {
  const classes = [
    'ui-button',
    `ui-button--${variant}`,
    size === 'small' ? 'ui-button--small' : '',
    disabled ? 'ui-button--disabled' : '',
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <button type={type} onClick={onClick} disabled={disabled} title={title} className={classes}>
      {children}
    </button>
  );
}
