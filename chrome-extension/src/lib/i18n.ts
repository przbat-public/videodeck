/**
 * DOM localization for the extension pages: `[data-i18n]` replaces the text
 * content, `[data-i18n-placeholder]` the placeholder and `[data-i18n-title]`
 * the title attribute with the message from `_locales/<lang>/messages.json`.
 * Missing messages fall back to the key, so an omission is visible, not silent.
 */

const localizedAttributes = [
  { attribute: 'data-i18n', apply: (el: HTMLElement, value: string) => (el.textContent = value) },
  {
    attribute: 'data-i18n-placeholder',
    apply: (el: HTMLElement, value: string) => ((el as HTMLInputElement).placeholder = value),
  },
  {
    attribute: 'data-i18n-title',
    apply: (el: HTMLElement, value: string) => (el.title = value),
  },
] as const;

export function localizeDom(root: ParentNode = document): void {
  for (const { attribute, apply } of localizedAttributes) {
    root.querySelectorAll<HTMLElement>(`[${attribute}]`).forEach((element) => {
      const key = element.getAttribute(attribute);
      if (key) {
        apply(element, chrome.i18n.getMessage(key) || key);
      }
    });
  }
}
