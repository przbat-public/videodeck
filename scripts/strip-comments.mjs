// @ts-check
/**
 * String-aware comment stripper shared by the lint scripts.
 *
 * Both check-hardcoded-polish and check-tsconfig-strict need the same state
 * machine (strip comments, keep string literals verbatim so `//` or `/*`
 * inside a string cannot break the scan). Duplicating it also tripped the
 * cognitive-complexity lint, so it lives here.
 */

/**
 * @typedef {{ mode: 'code' }} CodeState
 * @typedef {{ mode: 'line-comment' }} LineState
 * @typedef {{ mode: 'block-comment' }} BlockState
 * @typedef {{ mode: 'string', quote: string }} StringState
 * @typedef {CodeState | LineState | BlockState | StringState} StripState
 */

/** @typedef {{ out: string, state: StripState, consumed: number }} StripStep */

/** @type {CodeState} */
const CODE_STATE = { mode: 'code' };

/**
 * @param {string} source
 * @param {number} i
 * @param {string} quotes
 * @returns {StripStep}
 */
function stepCode(source, i, quotes) {
  const c = source[i] ?? '';
  const next = source[i + 1] ?? '';
  if (c === '/' && next === '/') return { out: '', state: { mode: 'line-comment' }, consumed: 2 };
  if (c === '/' && next === '*') return { out: '', state: { mode: 'block-comment' }, consumed: 2 };
  if (quotes.includes(c)) return { out: c, state: { mode: 'string', quote: c }, consumed: 1 };
  return { out: c, state: CODE_STATE, consumed: 1 };
}

/**
 * @param {string} source
 * @param {number} i
 * @returns {StripStep}
 */
function stepLineComment(source, i) {
  const c = source[i] ?? '';
  if (c === '\n') return { out: '\n', state: CODE_STATE, consumed: 1 };
  return { out: '', state: { mode: 'line-comment' }, consumed: 1 };
}

/**
 * @param {string} source
 * @param {number} i
 * @returns {StripStep}
 */
function stepBlockComment(source, i) {
  const c = source[i] ?? '';
  const next = source[i + 1] ?? '';
  if (c === '*' && next === '/') return { out: '  ', state: CODE_STATE, consumed: 2 };
  if (c === '\n') return { out: '\n', state: { mode: 'block-comment' }, consumed: 1 };
  return { out: '', state: { mode: 'block-comment' }, consumed: 1 };
}

/**
 * @param {string} source
 * @param {number} i
 * @param {string} quote
 * @returns {StripStep}
 */
function stepString(source, i, quote) {
  const c = source[i] ?? '';
  const next = source[i + 1] ?? '';
  if (c === '\\') return { out: c + next, state: { mode: 'string', quote }, consumed: 2 };
  if (c === quote) return { out: c, state: CODE_STATE, consumed: 1 };
  return { out: c, state: { mode: 'string', quote }, consumed: 1 };
}

/**
 * Strip `//` and block comments from source; string literals (delimited by
 * any character in `quotes`) are copied verbatim, so comment markers inside
 * strings survive. Newlines are preserved so line numbers stay intact.
 *
 * @param {string} source
 * @param {string} quotes
 * @returns {string}
 */
export function stripComments(source, quotes) {
  let out = '';
  let i = 0;
  /** @type {StripState} */
  let state = CODE_STATE;
  while (i < source.length) {
    /** @type {StripStep} */
    let step;
    switch (state.mode) {
      case 'line-comment':
        step = stepLineComment(source, i);
        break;
      case 'block-comment':
        step = stepBlockComment(source, i);
        break;
      case 'string':
        step = stepString(source, i, state.quote);
        break;
      default:
        step = stepCode(source, i, quotes);
    }
    out += step.out;
    i += step.consumed;
    state = step.state;
  }
  return out;
}
