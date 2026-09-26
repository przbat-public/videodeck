import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findTestHygieneViolations, listTestFiles, matcherText, TEST_FILE_RE } from './check-test-hygiene.mjs';

/**
 * @param {string} source
 * @returns {string[]}
 */
const rulesOf = (source) => findTestHygieneViolations(source).map((hit) => hit.rule);

test('flags a bare sleep helper, its definition and its call', () => {
  const source = [
    'const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));',
    "it('waits', async () => {",
    '  await sleep(350);',
    '});',
  ].join('\n');

  const hits = findTestHygieneViolations(source);

  assert.deepEqual(
    hits.map((hit) => hit.rule),
    ['no-bare-sleep', 'no-bare-sleep'],
  );
  assert.deepEqual(
    hits.map((hit) => hit.line),
    [1, 3],
  );
});

test('flags a hand-rolled sleep inside a test body only', () => {
  const source = [
    '/** Polls a predicate: the sanctioned fallback */',
    'async function waitForFile(predicate: () => boolean): Promise<void> {',
    '  while (!predicate()) {',
    '    await new Promise((resolve) => setTimeout(resolve, 10));',
    '  }',
    '}',
    '',
    "it('waits for the handler', async () => {",
    '  await new Promise((resolve) => setTimeout(resolve, 50));',
    '});',
  ].join('\n');

  const hits = findTestHygieneViolations(source);

  assert.deepEqual(rulesOf(source), ['no-hand-rolled-sleep']);
  assert.equal(hits[0]?.line, 9);
});

test('flags waitForTimeout and a focused test', () => {
  const source = ["it.only('runs alone', async () => {", '  await page.waitForTimeout(500);', '});'].join('\n');

  assert.deepEqual(rulesOf(source), ['no-focused-test', 'no-wait-for-timeout']);
});

test('flags a heading wait for a link the file clicks', () => {
  const source = [
    "it('opens a card', async () => {",
    "  await page.user.click(screen.getByRole('link', { name: /Historia kosmosu/ }));",
    "  await screen.findByRole('heading', { name: 'Historia kosmosu' });",
    '});',
  ].join('\n');

  const hits = findTestHygieneViolations(source);

  assert.deepEqual(rulesOf(source), ['no-heading-wait-for-clicked-link']);
  assert.equal(hits[0]?.line, 3);
});

test('leaves a heading wait alone when no clicked link carries that name', () => {
  const differentName = [
    "it('renders the detail page', async () => {",
    "  await renderApp('/video/deepE2e0001');",
    "  await screen.findByRole('heading', { name: 'Gleboka integracja' });",
    '});',
  ].join('\n');
  const queriedButNotClicked = [
    "it('lists the card', () => {",
    "  expect(screen.getByRole('link', { name: /Historia kosmosu/ })).toHaveAttribute('href', '/video/x');",
    "  expect(screen.getByRole('heading', { name: 'Historia kosmosu' })).toBeInTheDocument();",
    '});',
  ].join('\n');

  assert.deepEqual(findTestHygieneViolations(differentName), []);
  assert.deepEqual(findTestHygieneViolations(queriedButNotClicked), []);
});

test('flags a query assertion that cannot fail on absence', () => {
  const source = [
    "it('renders', () => {",
    "  expect(await screen.queryByText('Brak filmow')).toBeDefined();",
    '});',
  ].join('\n');

  assert.deepEqual(rulesOf(source), ['no-cannot-fail-query-assertion']);
});

test('ignores comments and the route-signal pattern', () => {
  const source = [
    '// sleep(350) used to sit here: past the search bar debounce',
    '/* await new Promise((resolve) => setTimeout(resolve, 10)); */',
    "it('navigates', async () => {",
    "  await page.user.click(screen.getByRole('link', { name: /Historia kosmosu/ }));",
    '  await waitFor(() => {',
    "    expect(page.router.state.location.pathname).toBe('/video/deepE2e0002');",
    "    expect(screen.queryByLabelText('Fraza wyszukiwania')).toBeNull();",
    '  });',
    '});',
  ].join('\n');

  assert.deepEqual(findTestHygieneViolations(source), []);
});

test('matcherText reduces strings and regex literals to the accessible name', () => {
  assert.equal(matcherText("'Historia kosmosu'"), 'Historia kosmosu');
  assert.equal(matcherText('/Wróć do listy/'), 'Wróć do listy');
  assert.equal(matcherText('/Back to list/i'), 'Back to list');
});

test('TEST_FILE_RE matches unit, integration and e2e specs only', () => {
  assert.ok(TEST_FILE_RE.test('/repo/client/src/pages/VideoListPage.test.tsx'));
  assert.ok(TEST_FILE_RE.test('/repo/server/src/services/downloadQueue.test.ts'));
  assert.ok(TEST_FILE_RE.test('/repo/client/e2e/app.spec.ts'));
  assert.ok(!TEST_FILE_RE.test('/repo/scripts/check-test-hygiene.test.mjs'));
  assert.ok(!TEST_FILE_RE.test('/repo/client/e2e/helpers.ts'));
  assert.ok(!TEST_FILE_RE.test('/repo/test-infra/src/fakeElasticsearch.ts'));
});

test('listTestFiles finds the suites and skips the helpers', () => {
  const files = listTestFiles();

  assert.ok(files.some((file) => file.endsWith('client/e2e/app.spec.ts')));
  assert.ok(files.some((file) => file.endsWith('server/src/services/downloadQueue.test.ts')));
  assert.ok(!files.some((file) => file.endsWith('client/e2e/helpers.ts')));
  assert.ok(!files.some((file) => file.includes('node_modules')));
});
