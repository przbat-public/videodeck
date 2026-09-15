import type { JSX } from 'react';

interface CheckboxProps {
  checked: boolean;
  /** Reports the new state on toggle */
  onChange: (checked: boolean) => void;
  /** Visible label — also the accessible name of the checkbox */
  label: string;
  disabled?: boolean;
  title?: string;
  className?: string;
}

/**
 * Reusable checkbox: a hidden native input (full keyboard/assistive-tech
 * support) drawn as a styled box with a check mark. The whole row is a
 * `<label>`, so clicking the text toggles too.
 */
export function Checkbox({
  checked,
  onChange,
  label,
  disabled = false,
  title,
  className = '',
}: CheckboxProps): JSX.Element {
  const classes = ['ui-checkbox', disabled ? 'ui-checkbox--disabled' : '', className].filter(Boolean).join(' ');
  return (
    <label className={classes} title={title}>
      <input
        type="checkbox"
        className="ui-checkbox-input"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="ui-checkbox-box" aria-hidden="true">
        <svg className="ui-checkbox-mark" viewBox="0 0 12 10" focusable="false" aria-hidden="true">
          <path
            d="M1 5.5 4.3 8.5 11 1.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </span>
      <span className="ui-checkbox-label">{label}</span>
    </label>
  );
}
