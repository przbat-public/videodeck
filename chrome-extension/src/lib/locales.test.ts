import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Key parity for the extension's own `_locales` catalogs (pl + en), mirroring
 * client/src/i18n/locales.test.ts: every key in one language must exist in
 * the other with the same `placeholders` shape, so chrome.i18n.getMessage can
 * never throw a "key missing" error for the other language.
 */

function loadMessages(
  locale: 'en' | 'pl',
): Record<string, { message: string; placeholders?: Record<string, unknown> }> {
  const path = fileURLToPath(new URL(`../../_locales/${locale}/messages.json`, import.meta.url));
  return JSON.parse(readFileSync(path, 'utf-8')) as Record<
    string,
    { message: string; placeholders?: Record<string, unknown> }
  >;
}

describe('_locales parity', () => {
  const en = loadMessages('en');
  const pl = loadMessages('pl');

  it('has the same keys in en and pl', () => {
    expect(Object.keys(pl).sort()).toEqual(Object.keys(en).sort());
  });

  it('keeps the placeholder shape identical across languages', () => {
    for (const key of Object.keys(en)) {
      expect(pl[key]?.placeholders).toEqual(en[key]?.placeholders);
    }
  });
});
