import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findMissingFlags, stripJsonComments } from './check-tsconfig-strict.mjs';

test('stripJsonComments removes line and block comments, keeps strings', () => {
  const source = [
    '{',
    '  // line comment',
    '  "paths": { "@shared/*": ["../shared/*"] }, // trailing',
    '  /* block',
    '     comment */ "strict": true',
    '}',
  ].join('\n');

  const stripped = stripJsonComments(source);

  assert.ok(!stripped.includes('line comment'));
  assert.ok(!stripped.includes('block'));
  assert.ok(stripped.includes('"@shared/*"'));
  // still valid JSON
  assert.deepEqual(JSON.parse(stripped), { paths: { '@shared/*': ['../shared/*'] }, strict: true });
});

test('reports weakened and missing flags', () => {
  const missing = findMissingFlags(
    { strict: true, exactOptionalPropertyTypes: false },
    { strict: true, exactOptionalPropertyTypes: true, noUncheckedIndexedAccess: true }
  );

  assert.deepEqual(missing, {
    exactOptionalPropertyTypes: false,
    noUncheckedIndexedAccess: undefined,
  });
});

test('accepts a fully strict config', () => {
  assert.deepEqual(
    findMissingFlags(
      { strict: true, exactOptionalPropertyTypes: true, noUncheckedIndexedAccess: true },
      { strict: true, exactOptionalPropertyTypes: true, noUncheckedIndexedAccess: true }
    ),
    {}
  );
});
