// @ts-check
/**
 * Static UX scanner for the client, a triage tool in the spirit of the
 * web-app-ux-auditor skill: regex based review signals, never verdicts.
 * Every finding must be confirmed in code, the browser, screenshots or
 * tests before changing behavior (see .agents/skills/responsive-design).
 *
 * Signals:
 *   - click-div:            onClick on a non-interactive element without a
 *                           role or tabIndex (keyboard dead end)
 *   - button-no-type:       <button> without an explicit type attribute
 *   - img-no-alt:           <img> without alt and without aria-hidden
 *   - hover-only-reveal:    :hover rules that reveal content (opacity,
 *                           display, visibility, transform) with no
 *                           visible focus-visible counterpart nearby
 *   - focus-outline-removal: outline: none/0 outside a :focus-visible rule
 *
 * Usage: node scripts/web-ux-static-scan.mjs [dir]
 * Exit code is always 0; the report is advisory.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const SIGNALS = {
  clickDiv: 'click-div',
  buttonNoType: 'button-no-type',
  imgNoAlt: 'img-no-alt',
  hoverOnlyReveal: 'hover-only-reveal',
  focusOutlineRemoval: 'focus-outline-removal',
};

/**
 * @typedef {{ signal: string, file: string, line: number, message: string }} Finding
 */

/** Files the scanner looks at, relative to the scanned root */
const SOURCE_EXTENSIONS = new Set(['.tsx', '.jsx', '.css']);

/** Walk a directory; returns relative paths of the supported files
 * @param {string} root
 * @returns {string[]}
 */
function collectFiles(root) {
  /** @type {string[]} */
  const files = [];
  /**
   * @param {string} dir
   */
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (entry === 'node_modules' || entry === 'dist' || entry === 'coverage') {
        continue;
      }
      const stats = statSync(full);
      if (stats.isDirectory()) {
        walk(full);
      } else if (SOURCE_EXTENSIONS.has(path.extname(entry))) {
        files.push(path.relative(root, full));
      }
    }
  };
  walk(root);
  return files.sort();
}

/** 1-based line number of an offset in a source string
 * @param {string} source
 * @param {number} offset
 * @returns {number}
 */
function lineOf(source, offset) {
  let line = 1;
  for (let i = 0; i < offset; i += 1) {
    if (source[i] === '\n') {
      line += 1;
    }
  }
  return line;
}

/**
 * The full JSX opening tag starting at `offset` (source[offset] is '<').
 * Reads to the matching '>' while honoring quoted strings and brace depth,
 * so a '>' inside an arrow function or a generic type does not end the tag.
 * @param {string} source
 * @param {number} offset
 * @returns {string}
 */
function openingTag(source, offset) {
  /** @type {number} */
  let depth = 0;
  for (let i = offset + 1; i < source.length; i += 1) {
    const char = source[i] ?? '';
    if (isQuoteChar(char)) {
      i = skipQuoted(source, i + 1, char);
      continue;
    }
    if (char === '{') {
      depth += 1;
      continue;
    }
    if (char === '}') {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (char === '>' && depth === 0) {
      return source.slice(offset, i + 1);
    }
  }
  return source.slice(offset);
}

/** Index of the quote that closes the value, or the end of the source
 * @param {string} source
 * @param {number} from
 * @param {string} quote
 * @returns {number}
 */
function skipQuoted(source, from, quote) {
  for (let i = from; i < source.length; i += 1) {
    const char = source[i] ?? '';
    if (char === '\\') {
      i += 1;
      continue;
    }
    if (char === quote) {
      return i;
    }
  }
  return source.length;
}

/** JSX attribute values may open a quote with any of these
 * @param {string} char
 * @returns {boolean}
 */
function isQuoteChar(char) {
  return char === '"' || char === "'" || char === '`';
}

/**
 * One review signal for an opening tag, or null when the tag is clean.
 * @param {string} name
 * @param {string} tag
 * @returns {{ signal: string, message: string } | null}
 */
function tagSignal(name, tag) {
  if (name === 'button' && !/type=/.test(tag)) {
    return { signal: SIGNALS.buttonNoType, message: 'button without an explicit type attribute' };
  }
  if (name === 'img' && !/alt=/.test(tag) && !/aria-hidden/.test(tag)) {
    return { signal: SIGNALS.imgNoAlt, message: 'img without alt text and without aria-hidden' };
  }
  const clickable = name === 'div' || name === 'span' || name === 'p' || name === 'li';
  if (clickable && /onClick=/.test(tag) && !/role=/.test(tag) && !/tabIndex=/.test(tag)) {
    return {
      signal: SIGNALS.clickDiv,
      message: 'onClick on a non-interactive element without role or tabIndex',
    };
  }
  return null;
}

/**
 * Scan one JSX/TSX source. Multi-line opening tags are handled by matching
 * tag names against the whole file and re-reading the real opening tag.
 * @param {string} source
 * @param {string} file
 * @returns {Finding[]}
 */
function scanTsx(source, file) {
  /** @type {Finding[]} */
  const findings = [];
  for (const match of source.matchAll(/<(button|img|div|span|p|li)\b/g)) {
    const name = match[1] ?? '';
    const offset = match.index ?? 0;
    const signal = tagSignal(name, openingTag(source, offset));
    if (signal) {
      findings.push({ ...signal, file, line: lineOf(source, offset) });
    }
  }
  return findings;
}

/** Outline removal signals, one per line
 * @param {string} source
 * @param {string} file
 * @param {boolean} hasFocusVisible
 * @returns {Finding[]}
 */
function scanCssOutlines(source, file, hasFocusVisible) {
  /** @type {Finding[]} */
  const findings = [];
  const lines = source.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (/outline:\s*(none|0)/.test(line)) {
      findings.push({
        signal: SIGNALS.focusOutlineRemoval,
        file,
        line: i + 1,
        message: hasFocusVisible
          ? 'outline removed; confirm a :focus-visible replacement covers this element'
          : 'outline removed and no :focus-visible rule exists in this file',
      });
    }
  }
  return findings;
}

/** Hover rules whose body hides or reveals content
 * @param {string} source
 * @param {string} file
 * @param {boolean} hasFocusVisible
 * @returns {Finding[]}
 */
function scanCssHoverReveals(source, file, hasFocusVisible) {
  /** @type {Finding[]} */
  const findings = [];
  const rules = source.matchAll(/([^{}]+)\{([^{}]*)\}/g);
  for (const rule of rules) {
    const selector = rule[1] ?? '';
    const body = rule[2] ?? '';
    if (!/:hover/.test(selector) || !/\b(opacity|display|visibility|transform)\s*:/.test(body)) {
      continue;
    }
    // The match starts at the trailing newline of the previous rule; the
    // real selector begins at its first non-whitespace character.
    const leadingWhitespace = (rule[0].match(/^\s*/) ?? [''])[0]?.length ?? 0;
    findings.push({
      signal: SIGNALS.hoverOnlyReveal,
      file,
      line: lineOf(source, (rule.index ?? 0) + leadingWhitespace),
      message: hasFocusVisible
        ? 'hover rule changes visibility; confirm the affordance also works via focus or tap'
        : 'hover rule changes visibility and no :focus-visible exists in this file',
    });
  }
  return findings;
}

/**
 * Scan one CSS source. The hover check stays conservative: it only flags
 * rules whose parent selector carries :hover and whose body changes what is
 * visible (opacity/display/visibility/transform).
 * @param {string} source
 * @param {string} file
 * @returns {Finding[]}
 */
function scanCss(source, file) {
  const hasFocusVisible = /:focus-visible/.test(source);
  return [...scanCssOutlines(source, file, hasFocusVisible), ...scanCssHoverReveals(source, file, hasFocusVisible)];
}

/** @param {string} root
 * @returns {Finding[]}
 */
export function scanRoot(root) {
  /** @type {Finding[]} */
  const findings = [];
  for (const file of collectFiles(root)) {
    const source = readFileSync(path.join(root, file), 'utf-8');
    const isCss = file.endsWith('.css');
    findings.push(...(isCss ? scanCss(source, file) : scanTsx(source, file)));
  }
  return findings;
}

/** Render findings as text lines plus a summary
 * @param {Finding[]} findings
 * @returns {string}
 */
export function renderReport(findings) {
  const lines = findings.map((finding) => `${finding.signal}\t${finding.file}:${finding.line}\t${finding.message}`);
  const files = new Set(findings.map((finding) => finding.file)).size;
  lines.push(`summary: ${findings.length} signals in ${files} files`);
  return lines.join('\n');
}

// Run directly: node scripts/web-ux-static-scan.mjs [dir]
const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  const root = process.argv[2] ?? 'client/src';
  console.log(renderReport(scanRoot(root)));
}
