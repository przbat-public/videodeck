import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findHardcodedPolish, stripComments } from './check-hardcoded-polish.mjs';

test('stripComments removes line and block comments but keeps string contents', () => {
  const source = [
    "const a = 'łódź'; // komentarz z ą",
    '/* blok z ę',
    '   dalej */',
    'const b = `// to nie komentarz: ść`;',
  ].join('\n');

  const stripped = stripComments(source);

  assert.ok(stripped.includes("'łódź'"));
  assert.ok(stripped.includes('// to nie komentarz: ść'));
  assert.ok(!stripped.includes('komentarz z ą'));
  assert.ok(!stripped.includes('blok z ę'));
});

test('findHardcodedPolish reports quoted Polish strings with line numbers', () => {
  const source = ['const x = "Brak filmów";', '// uwaga: ąćę', "const y = 'ok';"].join('\n');

  assert.deepEqual(findHardcodedPolish(source), [{ line: 1, text: 'Brak filmów' }]);
});

test('findHardcodedPolish ignores comments and non-Polish strings', () => {
  assert.deepEqual(findHardcodedPolish('// "Świetny komentarz"\nconst a = "english only";'), []);
});

test('findHardcodedPolish scans single, double and template quotes', () => {
  const source = 'a = \'ą\'; b = "ę"; c = `Kanał: ${name}`;';

  assert.deepEqual(
    findHardcodedPolish(source).map((hit) => hit.text),
    ['ą', 'ę', 'Kanał: ${name}']
  );
});
