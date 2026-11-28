import { createContext, use, useEffect } from 'react';

export interface AppMenuCheckboxSpec {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}

/** The dialog an item asks in before it runs, in the item's own words */
export interface AppMenuConfirmSpec {
  title: string;
  message: string;
  confirmLabel: string;
}

export interface AppMenuItemSpec {
  key: string;
  label: string;
  onSelect?: () => void;
  disabled?: boolean;
  active?: boolean;
  title?: string;
  checkbox?: AppMenuCheckboxSpec;
  /** Asks in a dialog before onSelect runs, for an action that cannot be taken back */
  confirm?: AppMenuConfirmSpec;
}

export interface AppMenuSectionSpec {
  key: string;
  label?: string;
  items: AppMenuItemSpec[];
}

/**
 * Pages register their menu sections through these contexts. The registry
 * keeps the menu generic: page hooks (search, reindex) stay in the page
 * that owns them, and the top bar only renders what a route registered.
 */
export const RegisterSectionsContext = createContext<(sections: AppMenuSectionSpec[]) => void>(() => undefined);
export const SectionsContext = createContext<AppMenuSectionSpec[]>([]);

/** Content signature: callbacks are dropped, only what renders is compared */
export function sectionsSignature(sections: AppMenuSectionSpec[]): unknown {
  return sections.map((section) => [
    section.key,
    section.label ?? '',
    section.items.map((item) => [
      item.key,
      item.label,
      item.disabled ?? false,
      item.active ?? false,
      item.title ?? '',
      item.checkbox?.checked ?? null,
      item.confirm ? [item.confirm.title, item.confirm.message, item.confirm.confirmLabel] : null,
    ]),
  ]);
}

/**
 * Registers menu sections for the lifetime of the calling component.
 * The effect clears them on unmount, so each route owns exactly its items.
 */
export function useRegisterMenuSections(sections: AppMenuSectionSpec[]): void {
  const register = use(RegisterSectionsContext);
  useEffect(() => {
    register(sections);
    return () => register([]);
  }, [register, sections]);
}

/** The sections the current route registered, for the menu to render */
export function useAppMenuSections(): AppMenuSectionSpec[] {
  return use(SectionsContext);
}
