import * as SelectPrimitive from '@radix-ui/react-select';
import type { JSX } from 'react';

export interface SelectOption {
  value: string;
  label: string;
}

interface SelectProps {
  value: string;
  /** Reports the newly chosen option value ('' for the "none" option) */
  onChange: (value: string) => void;
  /** Options in order; `value: ''` renders as the "no selection" choice */
  items: SelectOption[];
  disabled?: boolean;
  id?: string;
  /** Accessible name of the combobox */
  'aria-label'?: string;
  /** Extra classes applied to the trigger (keeps existing layout hooks) */
  className?: string;
}

/**
 * Radix UI Select behind the app's own props: full keyboard support,
 * typeahead, ARIA and portal positioning for free; the styling is ours
 * (see `.ui-select-*` in App.css).
 *
 * Radix rejects empty item values, so the "no selection" option ('' in our
 * API) is stored under a sentinel and mapped back on change — call sites
 * keep using ''.
 */
const EMPTY_VALUE = '__none__';

export function Select({
  value,
  onChange,
  items,
  disabled = false,
  id,
  'aria-label': ariaLabel,
  className = '',
}: SelectProps): JSX.Element {
  const radixValue = value === '' ? EMPTY_VALUE : value;
  const triggerClasses = ['ui-select-native', disabled ? 'ui-select--disabled' : '', className]
    .filter(Boolean)
    .join(' ');

  return (
    <SelectPrimitive.Root
      value={radixValue}
      onValueChange={(next) => onChange(next === EMPTY_VALUE ? '' : next)}
      disabled={disabled}
    >
      <SelectPrimitive.Trigger className={triggerClasses} id={id} aria-label={ariaLabel}>
        <SelectPrimitive.Value />
        <SelectPrimitive.Icon className="ui-select-icon">
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
        </SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Content className="ui-select-content" position="popper" sideOffset={4}>
          <SelectPrimitive.Viewport className="ui-select-viewport">
            {items.map((item) => (
              <SelectPrimitive.Item
                key={item.value}
                value={item.value === '' ? EMPTY_VALUE : item.value}
                className="ui-select-item"
              >
                <SelectPrimitive.ItemText>{item.label}</SelectPrimitive.ItemText>
                <SelectPrimitive.ItemIndicator className="ui-select-item-indicator">
                  ✓
                </SelectPrimitive.ItemIndicator>
              </SelectPrimitive.Item>
            ))}
          </SelectPrimitive.Viewport>
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  );
}
