import * as CheckboxPrimitive from '@radix-ui/react-checkbox';
import type { JSX } from 'react';

interface CheckboxProps {
  checked: boolean;
  /** Reports the new state on toggle */
  onChange: (checked: boolean) => void;
  /** Visible label — also the accessible name of the checkbox */
  label: string;
  disabled?: boolean;
  className?: string;
}

/**
 * Radix checkbox: a real button with the checkbox role (full keyboard and
 * assistive-tech support) styled as a box with a check mark. The whole row
 * is a `<label>`, so clicking the text toggles too.
 */
export function Checkbox({ checked, onChange, label, disabled = false, className = '' }: CheckboxProps): JSX.Element {
  const classes = ['ui-checkbox', disabled ? 'ui-checkbox--disabled' : '', className].filter(Boolean).join(' ');
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: the Radix root inside is a real button (role=checkbox), and the label keeps text clicks toggling
    <label className={classes}>
      <CheckboxPrimitive.Root
        className="ui-checkbox-box"
        checked={checked}
        disabled={disabled}
        onCheckedChange={(value) => onChange(value === true)}
      >
        <CheckboxPrimitive.Indicator className="ui-checkbox-mark">
          <svg viewBox="0 0 12 10" focusable="false" aria-hidden="true">
            <path
              d="M1 5.5 4.3 8.5 11 1.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </CheckboxPrimitive.Indicator>
      </CheckboxPrimitive.Root>
      <span className="ui-checkbox-label">{label}</span>
    </label>
  );
}
