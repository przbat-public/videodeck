import type { JSX, ReactNode, Ref } from 'react';

type ButtonVariant = 'neutral' | 'primary' | 'success' | 'danger';

interface ButtonProps {
  onClick?: () => void;
  disabled?: boolean;
  type?: 'button' | 'submit';
  variant?: ButtonVariant;
  size?: 'default' | 'small';
  /** Extra classes for layout (the variant covers the look) */
  className?: string;
  /** Forwarded to the DOM button, so Radix `asChild` triggers can wrap it */
  ref?: Ref<HTMLButtonElement>;
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
  type = 'button',
  variant = 'neutral',
  size = 'default',
  className = '',
  ref,
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
    <button ref={ref} type={type} onClick={onClick} disabled={disabled} className={classes}>
      {children}
    </button>
  );
}
