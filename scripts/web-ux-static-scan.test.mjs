import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { renderReport, scanRoot } from './web-ux-static-scan.mjs';

/**
 * Pins the static UX scanner on a fixture tree: every supported signal is
 * reported with its file and line, and clean patterns stay silent.
 */

const FIXTURE_TSX = `import type { JSX } from 'react';

export function BadCard(): JSX.Element {
  return (
    <div>
      <div onClick={() => undefined}>clickable div</div>
      <span onClick={() => undefined} role="button" tabIndex={0}>fine span</span>
      <button>no type</button>
      <button type="button">typed</button>
      <img src="poster.webp" />
      <img src="poster.webp" alt="Poster" />
      <img src="deco.webp" alt="" aria-hidden="true" />
    </div>
  );
}
`;

const FIXTURE_CSS = `.card { box-shadow: var(--shadow-card); }

.card:hover { box-shadow: var(--shadow-card-hover); }

.card:hover .play-overlay { opacity: 1; }

.card:focus-visible .play-overlay { opacity: 1; }

button { outline: none; }
`;

test('reports every supported signal with file and line, and skips clean patterns', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ux-scan-'));
  try {
    mkdirSync(path.join(dir, 'src'));
    writeFileSync(path.join(dir, 'src', 'fixture.tsx'), FIXTURE_TSX);
    writeFileSync(path.join(dir, 'src', 'fixture.css'), FIXTURE_CSS);

    const report = renderReport(scanRoot(path.join(dir, 'src')));

    assert.match(report, /click-div\tfixture\.tsx:6/);
    assert.match(report, /button-no-type\tfixture\.tsx:8/);
    assert.match(report, /img-no-alt\tfixture\.tsx:10/);
    assert.match(report, /hover-only-reveal\tfixture\.css:5/);
    assert.match(report, /focus-outline-removal\tfixture\.css:9/);

    // Clean patterns: role+tabIndex span, typed button, alt and decorative
    // images, hover rules that only change the shadow, focus-visible partner.
    assert.doesNotMatch(report, /fixture\.tsx:7\t/);
    assert.doesNotMatch(report, /fixture\.tsx:9\t/);
    assert.doesNotMatch(report, /fixture\.tsx:11\t/);
    assert.doesNotMatch(report, /fixture\.tsx:12\t/);
    assert.doesNotMatch(report, /fixture\.css:3\t/);
    assert.doesNotMatch(report, /fixture\.css:7\t/);

    assert.match(report, /summary: 5 signals in 2 files/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('returns an empty report for a directory without source files', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ux-scan-empty-'));
  try {
    writeFileSync(path.join(dir, 'notes.txt'), 'nothing here');
    const report = renderReport(scanRoot(dir));
    assert.equal(report, 'summary: 0 signals in 0 files');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
