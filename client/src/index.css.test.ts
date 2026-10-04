import { describe, expect, it } from 'vitest';
import appCss from './App.css?raw';
import indexCss from './index.css?raw';

/**
 * The palette contract.
 *
 * index.css used to declare the tokens twice, once per theme, which is how a
 * light value could drift from its dark twin or go missing from the dark block.
 * The palette now lives in one `:root` block: a value that changes with the
 * theme is written as `light-dark(<light>, <dark>)` and resolves against the
 * used `color-scheme`, while a token that reads the same in both themes stays a
 * single literal.
 */

/**
 * Tokens whose resolved value differs between the themes. The old dark block
 * repeated 23 tokens, but six of them carried the same literal as the light
 * block (the primary pair, the warning pair and the secondary pair), so only 17
 * of those need a `light-dark()` pair. The elevation tokens joined later: a
 * shadow that stays 10% black in dark mode is invisible there.
 */
const THEME_VARYING_TOKENS = [
  '--color-bg',
  '--color-bg-soft',
  '--color-surface',
  '--color-text',
  '--color-text-muted',
  '--color-border',
  '--color-primary-text',
  '--color-primary-soft',
  '--color-danger-bg',
  '--color-danger-text',
  '--color-info-bg',
  '--color-warning-bg',
  '--color-warning-text',
  '--color-warning-border',
  '--color-toast-bg',
  '--color-toast-text',
  '--color-focus-ring',
  '--color-backdrop',
  '--shadow-card',
  '--shadow-popover',
];

/**
 * Tokens with one theme-independent value: the eight the light block owned
 * alone (semantic colors, the focus ring, the card radius) plus the six
 * identical pairs listed above plus the halo base. They must stay plain
 * literals: a `light-dark(x, x)` would be a pair with no effect.
 */
const THEME_INVARIANT_TOKENS = [
  '--color-primary',
  '--color-primary-hover',
  '--color-success',
  '--color-success-hover',
  '--color-danger',
  '--color-danger-hover',
  '--color-info',
  '--color-info-hover',
  '--color-warning',
  '--color-warning-hover',
  '--color-secondary',
  '--color-secondary-hover',
  '--color-focus',
  '--color-halo',
  '--radius-card',
];

/** The stylesheet without comments, so no selector carries comment text */
const css = indexCss.replace(/\/\*[\s\S]*?\*\//g, '');

type CssBlock = { selector: string; body: string };

const blocks: CssBlock[] = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => ({
  selector: (match[1] ?? '').trim(),
  body: match[2] ?? '',
}));

function blockBody(selector: string): string {
  const found = blocks.find((candidate) => candidate.selector === selector);
  if (!found) {
    throw new Error(`index.css has no ${selector} block`);
  }
  return found.body;
}

/** The `--token: value` pairs of one block, in file order */
function tokenDeclarations(body: string): Map<string, string> {
  const tokens = new Map<string, string>();
  for (const match of body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
    const name = match[1];
    const value = match[2]?.trim();
    if (name !== undefined && value !== undefined) {
      tokens.set(name, value);
    }
  }
  return tokens;
}

const rootTokens = tokenDeclarations(blockBody(':root'));

/** The two arguments of a `light-dark()` value, commas inside rgba() included */
function splitLightDark(value: string): [string, string] {
  if (!value.startsWith('light-dark(') || !value.endsWith(')')) {
    throw new Error(`"${value}" is not a light-dark() value`);
  }
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const char of value.slice('light-dark('.length, -1)) {
    if (char === '(') {
      depth += 1;
    }
    if (char === ')') {
      depth -= 1;
    }
    if (char === ',' && depth === 0) {
      parts.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  parts.push(current.trim());
  const [light, dark] = parts;
  if (parts.length !== 2 || light === undefined || dark === undefined) {
    throw new Error(`"${value}" does not hold exactly two arguments`);
  }
  return [light, dark];
}

describe('index.css theme contract', () => {
  it('declares the whole palette once, in the single :root block', () => {
    expect([...rootTokens.keys()].sort()).toEqual([...THEME_VARYING_TOKENS, ...THEME_INVARIANT_TOKENS].sort());
  });

  it('writes every theme-varying token as light-dark(light, dark)', () => {
    for (const token of THEME_VARYING_TOKENS) {
      expect(rootTokens.get(token), `${token} must use light-dark()`).toMatch(/^light-dark\(.+,.+\)$/);
    }
  });

  it('keeps the theme-independent tokens a single literal', () => {
    for (const token of THEME_INVARIANT_TOKENS) {
      expect(rootTokens.get(token), `${token} reads the same in both themes`).not.toContain('light-dark(');
    }
  });

  it('never repeats a colour in the light and dark half of one token', () => {
    for (const token of THEME_VARYING_TOKENS) {
      const [light, dark] = splitLightDark(rootTokens.get(token) ?? '');
      expect(dark, `${token} repeats its light value`).not.toBe(light);
      const darkHexes = dark.match(/#[0-9a-f]{3,8}/gi) ?? [];
      for (const hex of light.match(/#[0-9a-f]{3,8}/gi) ?? []) {
        expect(darkHexes, `${token} uses ${hex} in both themes`).not.toContain(hex);
      }
    }
  });

  it('keeps the light value first in every light-dark() pair', () => {
    expect(rootTokens.get('--color-bg')).toBe('light-dark(#f5f5f5, #16181c)');
    expect(rootTokens.get('--color-surface')).toBe('light-dark(#fff, #1d1f24)');
    expect(rootTokens.get('--color-text')).toBe('light-dark(#333, #e6e6e6)');
    expect(rootTokens.get('--color-toast-text')).toBe('light-dark(#fff, #e6e6e6)');
  });

  it('declares no token outside :root', () => {
    const strays = blocks
      .filter((candidate) => candidate.selector !== ':root')
      .flatMap((candidate) => [...tokenDeclarations(candidate.body).keys()]);

    expect(strays).toEqual([]);
  });

  it('sets color-scheme for both schemes in :root and pins one per stored theme', () => {
    const schemeBlocks = blocks.filter((candidate) => candidate.body.includes('color-scheme'));

    expect(schemeBlocks.map((candidate) => candidate.selector)).toEqual([
      ':root',
      ":root[data-theme='light']",
      ":root[data-theme='dark']",
    ]);
    expect(blockBody(':root')).toContain('color-scheme: light dark;');
    expect(blockBody(":root[data-theme='light']").trim()).toBe('color-scheme: light;');
    expect(blockBody(":root[data-theme='dark']").trim()).toBe('color-scheme: dark;');
  });
});

/**
 * Elevation contract.
 *
 * App.css used to spell the shadow colours out as `rgba()` literals in thirteen
 * `box-shadow` declarations, which is how a card shadow stayed the same 10%
 * black in dark mode, where it is all but invisible (DESIGN.md section 3 says
 * shadows deepen in dark). Each shadow family is a token in index.css now, and
 * the shadows that tint themselves with a semantic colour mix it from that
 * token instead.
 */
const appCssWithoutComments = appCss.replace(/\/\*[\s\S]*?\*\//g, '');

/** Every `box-shadow` value in App.css, in file order */
const boxShadowValues = [...appCssWithoutComments.matchAll(/box-shadow\s*:\s*([^;}]+)/g)].map((match) =>
  (match[1] ?? '').trim(),
);

describe('App.css elevation contract', () => {
  it('declares every elevation token as a light-dark() pair', () => {
    for (const token of ['--shadow-card', '--shadow-popover']) {
      const value = rootTokens.get(token);
      expect(value, `${token} must be declared in the single :root block`).toBeDefined();
      const [light, dark] = splitLightDark(value ?? '');
      expect(light.length, `${token} needs a light value`).toBeGreaterThan(0);
      expect(dark.length, `${token} needs a dark value`).toBeGreaterThan(0);
      expect(dark, `${token} must deepen in dark`).not.toBe(light);
    }
  });

  it('keeps every box-shadow free of a colour literal', () => {
    // A regex that quietly stopped matching would make the assertion below
    // vacuous, so the scan proves it still sees the shadows first.
    expect(boxShadowValues.length).toBeGreaterThanOrEqual(13);
    const offenders = boxShadowValues.filter((value) => /#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i.test(value));

    expect(offenders, 'pick a token, or extend the token set (DESIGN.md section 2)').toEqual([]);

    // The scan above would miss a keyword colour, so the colour that ends every
    // shadow has to be a token or a mix of one.
    const untokened = boxShadowValues
      .filter((value) => value !== 'none')
      .filter((value) => !/(?:var\(--[\w-]+\)|color-mix\(.+\))$/.test(value));

    expect(untokened, 'every shadow colour comes from a token').toEqual([]);
  });
});
