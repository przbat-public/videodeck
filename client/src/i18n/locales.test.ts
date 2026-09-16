import { describe, expect, it } from 'vitest';
import en from './locales/en.json';
import pl from './locales/pl.json';

type LocaleTree = Record<string, unknown>;

function isLeaf(value: unknown): value is string {
  return typeof value === 'string';
}

/** Flatten the nested catalogs into "section.key" leaf paths */
function flatten(tree: LocaleTree, prefix = ''): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(tree)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (isLeaf(value)) {
      out[path] = value;
    } else {
      Object.assign(out, flatten(value as LocaleTree, path));
    }
  }
  return out;
}

const plFlat = flatten(pl);
const enFlat = flatten(en);

// Polish declines with one/few/many, English with one/other — a Polish
// "_few"/"_many" form is covered by the English "_other" form.
function englishTwin(key: string): string {
  return key.replace(/_(few|many)$/, '_other');
}

// Values that may legitimately be identical in both languages: language
// names shown in their own language and technical placeholders.
const IDENTICAL_ALLOWLIST = new Set([
  'languages.pl',
  'languages.en',
  'config.channelUrlPlaceholder',
  // "Sort" is the same word in Polish and English
  'search.sort',
  // language names shown in their own language
  'menu.polish',
  'menu.english',
]);

const INTERPOLATION = /\{\{/;

describe('locale catalogs', () => {
  it('gives every English key an exact Polish twin', () => {
    for (const key of Object.keys(enFlat)) {
      expect(plFlat[key], `missing Polish translation for "${key}"`).toBeDefined();
    }
  });

  it('gives every Polish key an English twin (few/many map to other)', () => {
    for (const key of Object.keys(plFlat)) {
      const twin = englishTwin(key);
      expect(enFlat[key] ?? enFlat[twin], `missing English translation for "${key}"`).toBeDefined();
    }
  });

  it('translates every shared key instead of copy-pasting it between languages', () => {
    for (const [key, value] of Object.entries(plFlat)) {
      const enValue = enFlat[key] ?? enFlat[englishTwin(key)];
      if (enValue === undefined || enValue !== value) {
        continue;
      }
      expect(
        IDENTICAL_ALLOWLIST.has(key) || INTERPOLATION.test(value),
        `"${key}" is identical in pl and en — translate it or allowlist it`,
      ).toBe(true);
    }
  });
});
