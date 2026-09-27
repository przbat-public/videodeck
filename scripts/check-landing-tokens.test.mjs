import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// docs/landing/index.html serves from a static host, so it cannot import the
// client stylesheet and copies the palette by hand. Nothing used to tie the two
// files together: a token change in client/src/index.css repainted the app and
// left the landing on the old color, with no signal. These tests read both
// files and fail on any drift, in either direction.
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CLIENT_CSS = path.join(ROOT, 'client', 'src', 'index.css');
const LANDING = path.join(ROOT, 'docs', 'landing', 'index.html');
const CLIENT_CSS_NAME = path.relative(ROOT, CLIENT_CSS);
const LANDING_NAME = path.relative(ROOT, LANDING);
const EM_DASH = String.fromCharCode(0x2014);
const MIN_CONTRAST = 4.5;

/** @typedef {{ selector: string; body: string; conditions: string[] }} Rule */
/** @typedef {{ light: string | null; dark: string | null }} SchemeColors */

/**
 * Reads a repo file as UTF-8.
 *
 * @param {string} file
 * @returns {string}
 */
const read = (file) => readFileSync(file, 'utf-8');

/**
 * The body of every `<style>` block in a document, in order. Empty when the
 * document carries no style of its own.
 *
 * @param {string} source
 * @returns {string[]}
 */
const styleBlocks = (source) =>
  [...source.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map((match) => match[1] ?? '');

/**
 * The CSS a document carries: its `<style>` blocks, or the whole file when it
 * is already a stylesheet.
 *
 * @param {string} source
 * @returns {string[]}
 */
const styleSheets = (source) => {
  const blocks = styleBlocks(source);
  return blocks.length > 0 ? blocks : [source];
};

/** @typedef {{ selector: string | null; prelude: string; body: string }} Frame */

/**
 * Opens a brace frame. A prelude that starts with `@` is an at-rule condition,
 * kept for the rules nested inside it; anything else is a selector.
 *
 * @param {string} prelude
 * @returns {Frame}
 */
const openFrame = (prelude) => ({ selector: prelude.startsWith('@') ? null : prelude, prelude, body: '' });

/**
 * Closes the innermost frame. A declaration block becomes a rule, carrying the
 * at-rule preludes that are still open around it; an at-rule just falls away.
 *
 * @param {Frame[]} open
 * @param {Rule[]} rules
 * @returns {void}
 */
const closeFrame = (open, rules) => {
  const frame = open.pop();
  if (frame?.selector) {
    rules.push({ selector: frame.selector, body: frame.body, conditions: open.map((f) => f.prelude) });
  }
};

/**
 * Flattens a stylesheet into its rules. Each rule keeps the at-rule preludes it
 * sits inside, so a block nested in `@media (prefers-color-scheme: dark)` stays
 * distinguishable from a bare `:root`. Neither stylesheet nests selectors, so
 * tracking brace depth is enough.
 *
 * @param {string} css
 * @returns {Rule[]}
 */
const parseRules = (css) => {
  /** @type {Frame[]} */
  const open = [];
  /** @type {Rule[]} */
  const rules = [];
  let pending = '';
  for (const char of css.replace(/\/\*[\s\S]*?\*\//g, '')) {
    const frame = open.at(-1);
    if (char === '{') {
      open.push(openFrame(pending.trim()));
      pending = '';
    } else if (char === '}') {
      closeFrame(open, rules);
      pending = '';
    } else if (frame?.selector) {
      frame.body += char;
    } else {
      pending += char;
    }
  }
  return rules;
};

/**
 * The custom properties one declaration block sets, keyed by property name.
 *
 * @param {string} body
 * @returns {Map<string, string>}
 */
const declarations = (body) => {
  /** @type {Map<string, string>} */
  const out = new Map();
  for (const match of body.matchAll(/(--[\w-]+)\s*:\s*([^;}]+)/g)) {
    const [, name, value] = match;
    if (name !== undefined && value !== undefined) out.set(name, value.trim());
  }
  return out;
};

const SHORT_HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{4})$/i;
const LONG_HEX = /^#(?:[0-9a-f]{6}|[0-9a-f]{8})$/i;
const LIGHT_DARK_PAIR = /^light-dark\(\s*(#[0-9a-f]{3,8})\s*,\s*(#[0-9a-f]{3,8})\s*\)$/i;

/**
 * Normalizes a hex literal so the same color compares equal however it was
 * written: `#fff` and `#ffffff` both become `#ffffff`. Returns null for
 * anything that is not a hex color.
 *
 * @param {string} value
 * @returns {string | null}
 */
const normalizeHex = (value) => {
  const hex = value.trim().toLowerCase();
  if (SHORT_HEX.test(hex)) return `#${[...hex.slice(1)].map((char) => char + char).join('')}`;
  return LONG_HEX.test(hex) ? hex : null;
};

/**
 * The scheme assignments one custom property value carries. A `light-dark(a, b)`
 * pair pins both schemes, while a plain hex leaves the scheme open (a null
 * mode) for the caller to fill in from the block that declared it. Values that
 * are not colors yield nothing.
 *
 * @param {string} value
 * @returns {Array<{ mode: 'light' | 'dark' | null; hex: string }>}
 */
const colorValue = (value) => {
  const pair = LIGHT_DARK_PAIR.exec(value.trim());
  if (pair !== null) {
    const light = normalizeHex(pair[1] ?? '');
    const dark = normalizeHex(pair[2] ?? '');
    if (light === null || dark === null) return [];
    return [
      { mode: 'light', hex: light },
      { mode: 'dark', hex: dark },
    ];
  }
  const hex = normalizeHex(value);
  return hex === null ? [] : [{ mode: null, hex }];
};

const DARK_SCOPE = /(?:data-theme\s*=\s*['"]?dark|prefers-color-scheme\s*:\s*dark)/i;

/**
 * The scheme a plain declaration belongs to: a `[data-theme='dark']` attribute
 * or a `prefers-color-scheme: dark` at-rule means dark, anything else light.
 *
 * @param {Rule} rule
 * @returns {'light' | 'dark'}
 */
const ruleMode = (rule) =>
  [rule.selector, ...rule.conditions].some((scope) => DARK_SCOPE.test(scope)) ? 'dark' : 'light';

/**
 * The light and dark values one token resolves to. A token declared for one
 * scheme only keeps that value in the other, because nothing overrides it
 * there; that is how a theme-independent literal (--color-primary) is written,
 * and it is also how a token that no dark block touches behaves. A value
 * declared for both schemes, whether as two blocks or as one `light-dark()`
 * pair, gets one value per scheme.
 *
 * @param {Array<{ mode: 'light' | 'dark'; hex: string }>} entries
 * @returns {SchemeColors}
 */
const resolveSchemes = (entries) => {
  /** @type {string | null} */
  let light = null;
  /** @type {string | null} */
  let dark = null;
  for (const entry of entries) {
    if (entry.mode === 'dark') dark = entry.hex;
    else light = entry.hex;
  }
  if (light === null) return { light: null, dark };
  return { light, dark: dark ?? light };
};

/**
 * The custom properties of every `:root` rule in one stylesheet, each paired
 * with the rule that declared it.
 *
 * @param {string} sheet
 * @returns {Array<{ name: string; value: string; rule: Rule }>}
 */
const rootDeclarations = (sheet) => {
  /** @type {Array<{ name: string; value: string; rule: Rule }>} */
  const out = [];
  for (const rule of parseRules(sheet)) {
    if (!rule.selector.startsWith(':root')) continue;
    for (const [name, value] of declarations(rule.body)) out.push({ name, value, rule });
  }
  return out;
};

/**
 * Every color token a document defines, with the value it resolves to per
 * scheme. Handles both shapes the palette can take: a light `:root` block plus
 * a dark one, or a single block of `light-dark(light, dark)` pairs.
 *
 * @param {string} source
 * @returns {Map<string, SchemeColors>}
 */
const readTokens = (source) => {
  /** @type {Map<string, Array<{ mode: 'light' | 'dark'; hex: string }>>} */
  const raw = new Map();
  for (const sheet of styleSheets(source)) {
    for (const { name, value, rule } of rootDeclarations(sheet)) {
      for (const color of colorValue(value)) {
        const mode = color.mode ?? ruleMode(rule);
        raw.set(name, [...(raw.get(name) ?? []), { mode, hex: color.hex }]);
      }
    }
  }
  /** @type {Map<string, SchemeColors>} */
  const tokens = new Map();
  for (const [name, entries] of raw) tokens.set(name, resolveSchemes(entries));
  return tokens;
};

/**
 * Maps every color a palette resolves to back to the tokens that produce it, so
 * a failure can name them.
 *
 * @param {Map<string, SchemeColors>} tokens
 * @returns {Map<string, string[]>}
 */
const hexOwners = (tokens) => {
  /** @type {Map<string, string[]>} */
  const owners = new Map();
  for (const [name, value] of tokens) {
    for (const hex of [value.light, value.dark]) {
      if (hex === null) continue;
      owners.set(hex, [...(owners.get(hex) ?? []), name]);
    }
  }
  return owners;
};

/**
 * The tokens a document declares for one scheme, as literal values.
 *
 * @param {string} source
 * @param {'light' | 'dark'} mode
 * @returns {Map<string, string>}
 */
const schemeTokens = (source, mode) => {
  /** @type {Map<string, string>} */
  const out = new Map();
  for (const [name, value] of readTokens(source)) {
    const hex = value[mode];
    if (hex !== null) out.set(name, hex);
  }
  return out;
};

/**
 * The 1-based line the first occurrence of a literal sits on, for messages.
 *
 * @param {string} source
 * @param {string} needle
 * @returns {number}
 */
const lineOf = (source, needle) => {
  const index = source.indexOf(needle);
  return index === -1 ? 0 : source.slice(0, index).split('\n').length;
};

/**
 * Every hex literal the document can paint, mapped to the line it sits on. Only
 * two places here accept a raw color: a `<style>` block and a `style="..."
 * attribute. An inline SVG presentation attribute would need a third, and this
 * document has none.
 *
 * @param {string} source
 * @returns {Map<string, number>}
 */
const literalHexes = (source) => {
  /** @type {Map<string, number>} */
  const found = new Map();
  const attributes = [...source.matchAll(/\sstyle\s*=\s*"([^"]*)"/gi)].map((match) => match[1] ?? '');
  for (const css of [...styleBlocks(source), ...attributes]) {
    for (const match of css.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) {
      const hex = normalizeHex(match[0]);
      if (hex === null || found.has(hex)) continue;
      found.set(hex, lineOf(source, match[0]));
    }
  }
  return found;
};

/**
 * The sRGB channels of a normalized six digit hex color.
 *
 * @param {string} hex
 * @returns {number[]}
 */
const channels = (hex) => [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16));

/**
 * Linearizes one sRGB channel for the WCAG luminance formula.
 *
 * @param {number} channel
 * @returns {number}
 */
const toLinear = (channel) => {
  const value = channel / 255;
  return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
};

/**
 * WCAG 2.1 relative luminance of a hex color.
 *
 * @param {string} hex
 * @returns {number}
 */
const luminance = (hex) => {
  const [r, g, b] = channels(hex).map(toLinear);
  return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0);
};

/**
 * WCAG 2.1 contrast ratio between two opaque colors, from 1 to 21.
 *
 * @param {string} one
 * @param {string} other
 * @returns {number}
 */
const contrast = (one, other) => {
  const [high, low] = [luminance(one), luminance(other)].sort((a, b) => b - a);
  return ((high ?? 0) + 0.05) / ((low ?? 0) + 0.05);
};

/**
 * The color the browser paints for a text color the stylesheet fades over its
 * background. Opacity composites, so the ratio has to be measured on the blend
 * rather than on the declared color.
 *
 * @param {string} foreground
 * @param {string} background
 * @param {number} alpha
 * @returns {string}
 */
const blend = (foreground, background, alpha) => {
  const front = channels(foreground);
  const back = channels(background);
  const mix = (f = 0, b = 0) => Math.round(f * alpha + b * (1 - alpha));
  const mixed = front.map((channel, index) => mix(channel, back[index]));
  return `#${mixed.map((channel) => channel.toString(16).padStart(2, '0')).join('')}`;
};

/**
 * Resolves a token name against a scheme palette, or normalizes a literal.
 *
 * @param {string} spec
 * @param {Map<string, string>} palette
 * @returns {string}
 */
const resolve = (spec, palette) => {
  if (!spec.startsWith('--')) return normalizeHex(spec) ?? spec;
  const hex = palette.get(spec);
  assert.ok(hex !== undefined, `the landing declares no ${spec} for the scheme being checked`);
  return hex;
};

/**
 * Fails the calling test when a spec is missing, and narrows it away for the
 * code after.
 *
 * @param {string | null} spec
 * @param {string} what
 * @returns {string}
 */
const required = (spec, what) => {
  assert.ok(spec !== null, `${LANDING_NAME} paints no flat ${what}`);
  return spec;
};

/**
 * The plain declarations of one block, keyed by property name. Custom
 * properties are read by `declarations` instead, which keys on `--`.
 *
 * @param {string} body
 * @returns {Map<string, string>}
 */
const properties = (body) => {
  /** @type {Map<string, string>} */
  const out = new Map();
  for (const match of body.matchAll(/(?:^|;)\s*([a-z-]+)\s*:\s*([^;}]+)/g)) {
    const [, name, value] = match;
    if (name !== undefined && value !== undefined) out.set(name, value.trim());
  }
  return out;
};

/**
 * The declaration block of one rule in the landing, found by its exact
 * selector. Reading a rule beats restating its colors in this file: swapping
 * the token a rule paints with then shows up here on its own.
 *
 * @param {string} source
 * @param {string} selector
 * @returns {string}
 */
const ruleBody = (source, selector) => {
  const rule = styleSheets(source)
    .flatMap((sheet) => parseRules(sheet))
    .find((candidate) => candidate.selector === selector);
  assert.ok(rule !== undefined, `${LANDING_NAME} has no ${selector} rule`);
  return rule.body;
};

/**
 * The color one property of a declaration block paints: a token name, or a hex
 * literal. Anything that is not a flat color (a gradient, a keyword) yields
 * null, because this check cannot measure it.
 *
 * @param {string} body
 * @param {string} property
 * @returns {string | null}
 */
const paintedColor = (body, property) => {
  const value = properties(body).get(property);
  if (value === undefined) return null;
  const token = /^var\(\s*(--[\w-]+)\s*\)$/.exec(value);
  return token === null ? normalizeHex(value) : (token[1] ?? null);
};

/**
 * The landing's two scheme palettes, keyed by mode.
 *
 * @param {string} source
 * @returns {Map<string, Map<string, string>>}
 */
const landingPalettes = (source) =>
  new Map([
    ['light', schemeTokens(source, 'light')],
    ['dark', schemeTokens(source, 'dark')],
  ]);

// Hex literals the landing may paint without a client token, because they are
// the landing's own decoration rather than part of the product palette. Each
// entry has to name what it paints, so the list cannot become a dumping ground
// for stale copies of the palette.
const LANDING_ONLY_HEXES = new Map([
  // End stop of the landing's header gradient. DESIGN.md, section 2, allows the
  // gradient as a decorative surface, and client/src/index.css has no token for
  // its purple, so there is nothing here to mirror.
  ['#764ba2', 'header gradient end'],
]);

// The tokens the landing's hand copied palette came from, frozen as of the
// commit that added this test. When a value stops matching, the failure names
// the token it used to mirror instead of reporting a bare color.
const SOURCE_TOKENS = new Map([
  ['#f5f5f5', '--color-bg'],
  ['#ffffff', '--color-surface'],
  ['#333333', '--color-text'],
  ['#666666', '--color-text-muted'],
  ['#e0e0e0', '--color-border'],
  ['#5a5fd8', '--color-primary'],
  ['#4b56c9', '--color-primary-hover'],
  ['#eef0ff', '--color-primary-soft'],
  ['#4449b3', '--color-primary-text'],
]);

// Rules that declare both the text color and the surface behind it, so the
// pair can be read straight out of the stylesheet rather than restated here.
const SELF_CONTAINED_RULES = ['body', 'header .cta'];

// Text and background pairs that span two rules, where the surface comes from
// an ancestor or from the header gradient. Read as `[foreground, background,
// what it paints, opacity?]`; a name starting with `--` resolves against the
// scheme being checked, so the check follows the palette instead of pinning
// today's hexes.
/** @type {[string, string, string, number?][]} */
const TEXT_PAIRS = [
  ['--color-text', '--color-surface', 'feature cards and code blocks'],
  ['--color-text-muted', '--color-bg', 'the quick start note and footer copy'],
  ['--color-text-muted', '--color-surface', 'feature copy and screenshot captions'],
  ['#ffffff', '--color-primary', 'header copy on the gradient start'],
  ['#ffffff', '#764ba2', 'header copy on the gradient end'],
  ['#ffffff', '--color-primary', 'header intro copy, faded to 92%', 0.92],
];

test('the token parser treats a lone literal as the same value in both schemes', () => {
  const tokens = readTokens(':root { --color-bg: #f5f5f5; }');
  assert.deepEqual(tokens.get('--color-bg'), { light: '#f5f5f5', dark: '#f5f5f5' });
});

test('the token parser reads a light-dark() pair from a single block', () => {
  const tokens = readTokens(':root { --color-bg: light-dark(#f5f5f5, #16181c); }');
  assert.deepEqual(tokens.get('--color-bg'), { light: '#f5f5f5', dark: '#16181c' });
});

test('the token parser splits a light block from a data-theme dark block', () => {
  const css = [':root { --color-bg: #f5f5f5; }', ":root[data-theme='dark'] { --color-bg: #16181c; }"].join('\n');
  assert.deepEqual(readTokens(css).get('--color-bg'), { light: '#f5f5f5', dark: '#16181c' });
});

test('the token parser splits a dark block nested in a media query', () => {
  const css = [
    ':root { --color-bg: #f5f5f5; }',
    '@media (prefers-color-scheme: dark) {',
    '  :root { --color-bg: #16181c; }',
    '}',
  ].join('\n');
  assert.deepEqual(readTokens(css).get('--color-bg'), { light: '#f5f5f5', dark: '#16181c' });
});

test('the token parser expands shorthand and skips values that are not colors', () => {
  const tokens = readTokens(':root { --a: #fff; --radius-card: 8px; --ring: rgba(1, 2, 3, 0.2); }');
  assert.deepEqual(tokens.get('--a'), { light: '#ffffff', dark: '#ffffff' });
  assert.equal(tokens.has('--radius-card'), false);
  assert.equal(tokens.has('--ring'), false);
});

test('the token parser leaves the light side empty for a dark-only token', () => {
  const css = '@media (prefers-color-scheme: dark) { :root { --halo: #123456; } }';
  assert.deepEqual(readTokens(css).get('--halo'), { light: null, dark: '#123456' });
});

test('the landing tells the browser it supports both color schemes', () => {
  const html = read(LANDING);
  // Asserting on a matched boolean, not on the pattern, keeps the failure
  // message readable: assert.match would print the whole document.
  const declaresBoth = /:root\s*\{[^}]*color-scheme:\s*light dark/.test(html);
  const hasDarkBlock = /@media\s*\(prefers-color-scheme:\s*dark\)/.test(html);
  assert.ok(declaresBoth, `${LANDING_NAME} does not declare color-scheme: light dark on :root`);
  assert.ok(hasDarkBlock, `${LANDING_NAME} has no prefers-color-scheme: dark block`);
});

test('the landing mirrors the client palette token by token in both schemes', () => {
  const client = readTokens(read(CLIENT_CSS));
  const html = read(LANDING);
  const light = schemeTokens(html, 'light');
  const dark = schemeTokens(html, 'dark');
  const declared = [...new Set([...light.keys(), ...dark.keys()])];
  assert.ok(declared.length > 0, `${LANDING_NAME} declares no color tokens`);
  for (const token of declared) {
    const expected = client.get(token);
    assert.ok(expected !== undefined, `${LANDING_NAME} declares ${token}, which ${CLIENT_CSS_NAME} does not define`);
    assert.deepEqual(
      { light: light.get(token) ?? null, dark: dark.get(token) ?? null },
      { light: expected.light, dark: expected.dark },
      `${LANDING_NAME} drifted from ${CLIENT_CSS_NAME} on ${token}`,
    );
  }
});

test('every color the landing paints comes from a client token or a listed exception', () => {
  const client = readTokens(read(CLIENT_CSS));
  const owners = hexOwners(client);
  const html = read(LANDING);
  /** @type {string[]} */
  const failures = [];
  for (const [hex, line] of literalHexes(html)) {
    if (owners.has(hex) || LANDING_ONLY_HEXES.has(hex)) continue;
    const source = SOURCE_TOKENS.get(hex);
    const mirrored = source === undefined ? undefined : client.get(source);
    const drifted =
      source === undefined || mirrored === undefined
        ? null
        : `${source} now resolves to ${mirrored.light ?? 'nothing'} in light and ${mirrored.dark ?? 'nothing'} in dark.`;
    failures.push(
      [
        `${LANDING_NAME}:${line} paints ${hex}, which no token in ${CLIENT_CSS_NAME} resolves to.`,
        drifted,
        'Copy the token value, or add the literal to LANDING_ONLY_HEXES with a comment naming what it paints.',
      ]
        .filter((part) => part !== null)
        .join('\n'),
    );
  }
  assert.deepEqual(failures, [], `the landing palette drifted from the client palette:\n\n${failures.join('\n\n')}`);
});

test('the landing-only allowlist stays tight', () => {
  const owners = hexOwners(readTokens(read(CLIENT_CSS)));
  const painted = literalHexes(read(LANDING));
  for (const [hex, what] of LANDING_ONLY_HEXES) {
    const tokens = owners.get(hex);
    assert.equal(
      tokens,
      undefined,
      `${hex} (${what}) is allowlisted as landing-only, but ${CLIENT_CSS_NAME} now provides it through ${tokens?.join(', ')}; drop the entry`,
    );
    assert.ok(painted.has(hex), `${hex} (${what}) is allowlisted but never painted; drop the entry`);
  }
});

test('the landing keeps text at 4.5:1 or better in both color schemes', () => {
  const html = read(LANDING);
  /** @type {string[]} */
  const failures = [];

  /**
   * Measures one pair and records the failure instead of stopping at the first
   * one, so a report lists every pair that needs attention.
   *
   * @param {string} mode
   * @param {Map<string, string>} palette
   * @param {string} what
   * @param {string} foreground
   * @param {string} background
   * @param {number} [opacity]
   * @returns {void}
   */
  const measure = (mode, palette, what, foreground, background, opacity = 1) => {
    const back = resolve(background, palette);
    const front = resolve(foreground, palette);
    const painted = opacity === 1 ? front : blend(front, back, opacity);
    const ratio = contrast(painted, back);
    if (ratio < MIN_CONTRAST) {
      failures.push(
        `${what} in ${mode}: ${painted} on ${back} is ${ratio.toFixed(2)}:1, short of the ${MIN_CONTRAST}:1 WCAG AA minimum`,
      );
    }
  };

  // Pairs the stylesheet states in one rule: the color and the surface it lands on.
  /** @type {Array<[string, string, string]>} */
  const stated = SELF_CONTAINED_RULES.map((selector) => {
    const body = ruleBody(html, selector);
    return [
      selector,
      required(paintedColor(body, 'color'), `${selector} text color`),
      required(paintedColor(body, 'background'), `${selector} background`),
    ];
  });
  // The footer sets only a border, so its link sits on the page background.
  const link = required(paintedColor(ruleBody(html, 'footer a'), 'color'), 'footer link color');

  for (const [mode, palette] of landingPalettes(html)) {
    for (const [selector, text, surface] of stated) measure(mode, palette, selector, text, surface);
    measure(mode, palette, 'the footer link', link, '--color-bg');
    for (const [foreground, background, what, opacity] of TEXT_PAIRS) {
      measure(mode, palette, what, foreground, background, opacity);
    }
  }
  assert.deepEqual(failures, [], `${LANDING_NAME} text contrast:\n\n${failures.join('\n')}`);
});

test('the landing carries no em dash', () => {
  const html = read(LANDING);
  const index = html.indexOf(EM_DASH);
  assert.equal(
    index,
    -1,
    `${LANDING_NAME}:${lineOf(html, EM_DASH)} uses an em dash; the house prose rule wants a colon or a hyphen`,
  );
});
