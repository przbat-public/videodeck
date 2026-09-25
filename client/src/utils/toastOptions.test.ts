import { describe, expect, it } from 'vitest';
import indexCss from '../index.css?raw';
import { TOAST_OPTIONS } from './toastOptions';

/**
 * The toast surface is styled in JavaScript (react-hot-toast takes inline
 * options), which is exactly how a palette drifts away from DESIGN.md: the
 * literals that used to live in App.tsx ignored both the tokens and dark
 * mode. These tests pin the options to the stylesheet.
 */

/** Every string the options paint with: the base style and each icon theme */
function toastColours(): string[] {
  const { style, success, error } = TOAST_OPTIONS;
  return [
    ...Object.values(style ?? {}),
    ...Object.values(success?.iconTheme ?? {}),
    ...Object.values(error?.iconTheme ?? {}),
  ].map(String);
}

const referencedTokens = (): string[] =>
  toastColours().map((colour) => {
    const match = /^var\((--[a-z0-9-]+)\)$/.exec(colour);
    if (match?.[1] === undefined) {
      throw new Error(`"${colour}" is not a token reference`);
    }
    return match[1];
  });

const lightBlock = indexCss.slice(indexCss.indexOf(':root {'), indexCss.indexOf(":root[data-theme='dark']"));
const darkBlock = indexCss.slice(indexCss.indexOf(":root[data-theme='dark']"));

describe('toastOptions', () => {
  it('paints with design tokens instead of colour literals', () => {
    const colours = toastColours();

    expect(colours.length).toBeGreaterThan(0);
    for (const colour of colours) {
      expect(colour, `${colour} is a literal, not a token`).toMatch(/^var\(--[a-z0-9-]+\)$/);
    }
  });

  it('reuses the semantic tokens for the success and error icons', () => {
    expect(TOAST_OPTIONS.success?.iconTheme?.primary).toBe('var(--color-success)');
    expect(TOAST_OPTIONS.error?.iconTheme?.primary).toBe('var(--color-danger)');
  });

  it('defines every referenced token in the stylesheet, both themes for the toast surface', () => {
    const tokens = referencedTokens();

    for (const token of tokens) {
      expect(lightBlock, `${token} is not defined in index.css`).toContain(`${token}:`);
    }
    // The toast background and text are the ones that must flip with the theme
    for (const token of ['--color-toast-bg', '--color-toast-text']) {
      expect(tokens).toContain(token);
      expect(darkBlock, `${token} has no dark value`).toContain(`${token}:`);
    }
  });
});
