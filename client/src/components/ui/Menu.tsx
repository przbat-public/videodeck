import * as MenuPrimitive from '@radix-ui/react-dropdown-menu';
import type { ComponentProps, JSX } from 'react';

type MenuProps = ComponentProps<typeof MenuPrimitive.Root>;
type MenuTriggerProps = ComponentProps<typeof MenuPrimitive.Trigger>;
type MenuContentProps = ComponentProps<typeof MenuPrimitive.Content>;
type MenuCheckboxItemProps = ComponentProps<typeof MenuPrimitive.CheckboxItem>;
type MenuLabelProps = ComponentProps<typeof MenuPrimitive.Label>;
type MenuSeparatorProps = ComponentProps<typeof MenuPrimitive.Separator>;

/**
 * Radix DropdownMenu behind the app's own props: the WAI-ARIA menu button
 * pattern (aria-haspopup, aria-expanded, role=menu, full keyboard support,
 * typeahead, focus return) for free; the styling is ours (see
 * `.ui-menu-*` in App.css). Thin wrappers only — call sites compose the
 * sections.
 */
export function Menu(props: MenuProps): JSX.Element {
  return <MenuPrimitive.Root {...props} />;
}

export function MenuTrigger({ className = '', ...props }: MenuTriggerProps): JSX.Element {
  return <MenuPrimitive.Trigger className={['ui-menu-trigger', className].filter(Boolean).join(' ')} {...props} />;
}

export function MenuContent({ className = '', children, ...props }: MenuContentProps): JSX.Element {
  return (
    <MenuPrimitive.Portal>
      <MenuPrimitive.Content
        align="end"
        sideOffset={4}
        className={['ui-menu-content', className].filter(Boolean).join(' ')}
        {...props}
      >
        {children}
      </MenuPrimitive.Content>
    </MenuPrimitive.Portal>
  );
}

export interface MenuItemProps extends ComponentProps<typeof MenuPrimitive.Item> {
  /** Marks the current choice with the trailing ✓ indicator (app-level prop) */
  active?: boolean;
}

export function MenuItem({ className = '', active = false, children, ...props }: MenuItemProps): JSX.Element {
  return (
    <MenuPrimitive.Item className={['ui-menu-item', className].filter(Boolean).join(' ')} {...props}>
      {children}
      {active && (
        <span className="ui-menu-item-indicator" aria-hidden="true">
          ✓
        </span>
      )}
    </MenuPrimitive.Item>
  );
}

export function MenuCheckboxItem({ className = '', children, onSelect, ...props }: MenuCheckboxItemProps): JSX.Element {
  return (
    <MenuPrimitive.CheckboxItem
      className={['ui-menu-item', className].filter(Boolean).join(' ')}
      onSelect={(event) => {
        // A checkbox toggle keeps the menu open, so the user can flip
        // several switches in one visit (Radix closes on select unless the
        // default is prevented).
        onSelect?.(event);
        event.preventDefault();
      }}
      {...props}
    >
      <MenuPrimitive.ItemIndicator className="ui-menu-checkbox-indicator" aria-hidden="true">
        ✓
      </MenuPrimitive.ItemIndicator>
      {children}
    </MenuPrimitive.CheckboxItem>
  );
}

export function MenuLabel({ className = '', ...props }: MenuLabelProps): JSX.Element {
  return <MenuPrimitive.Label className={['ui-menu-label', className].filter(Boolean).join(' ')} {...props} />;
}

export function MenuSeparator({ className = '', ...props }: MenuSeparatorProps): JSX.Element {
  return <MenuPrimitive.Separator className={['ui-menu-separator', className].filter(Boolean).join(' ')} {...props} />;
}
