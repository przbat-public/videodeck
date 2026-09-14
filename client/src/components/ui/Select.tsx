import type { JSX, ReactNode } from 'react';

interface SelectProps {
  value: string;
  /** Reports the newly chosen option value */
  onChange: (value: string) => void;
  disabled?: boolean;
  id?: string;
  /** Accessible name of the combobox (mirrors the native aria-label) */
  'aria-label'?: string;
  /** Extra classes applied to the native select (keeps existing layout rules) */
  className?: string;
  /** `<option>` elements */
  children: ReactNode;
}

/**
 * Reusable select: the native `<select>` stays intact (keyboard, screen
 * readers, `selectOption` in tests, mobile pickers), but the browser chrome
 * is hidden and replaced with a styled box plus a custom chevron.
 */
export function Select({
  value,
  onChange,
  disabled = false,
  id,
  'aria-label': ariaLabel,
  className = '',
  children,
}: SelectProps): JSX.Element {
  return (
    <div className={`ui-select${disabled ? ' ui-select--disabled' : ''}`}>
      <select
        id={id}
        className={`ui-select-native ${className}`.trim()}
        value={value}
        disabled={disabled}
        aria-label={ariaLabel}
        onChange={(event) => onChange(event.target.value)}
      >
        {children}
      </select>
      <svg className="ui-select-arrow" viewBox="0 0 10 6" aria-hidden="true" focusable="false">
        <path
          d="M1 1l4 4 4-4"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </div>
  );
}
