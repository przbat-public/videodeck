import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// Repo-invariant checks for the repo-scoped skill catalog under .agents/.
// Every skill must carry frontmatter whose `name` matches its directory and
// a non-empty `description`, and no Markdown file under .agents/ may use an
// em dash (the house prose rule from the humanizer skill).
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const AGENTS = path.join(ROOT, '.agents');
const EM_DASH = String.fromCharCode(0x2014);

/**
 * @param {string} dir
 * @returns {string[]}
 */
const subdirs = (dir) =>
  readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(dir, entry.name));

/**
 * @param {string} dir
 * @returns {string[]}
 */
const markdownFiles = (dir) => {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...markdownFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      out.push(full);
    }
  }
  return out;
};

/**
 * Parses the leading YAML-ish frontmatter block. Missing or malformed
 * frontmatter yields an empty object so the caller reports a clear failure.
 *
 * @param {string} content
 * @returns {Record<string, string>}
 */
const parseFrontmatter = (content) => {
  /** @type {Record<string, string>} */
  const fields = {};
  if (!content.startsWith('---\n')) return fields;
  const end = content.indexOf('\n---', 4);
  if (end === -1) return fields;
  for (const line of content.slice(4, end).split('\n')) {
    const match = /^([a-z-]+):\s*(.*)$/.exec(line);
    if (match !== null && match[1] !== undefined) {
      fields[match[1]] = (match[2] ?? '').trim();
    }
  }
  return fields;
};

test('every skill carries frontmatter with a matching name and a description', () => {
  const skillRoot = path.join(AGENTS, 'skills');
  assert.ok(existsSync(skillRoot), '.agents/skills/ must exist');
  const dirs = subdirs(skillRoot);
  assert.ok(dirs.length > 0, 'no skill directories found under .agents/skills/');
  for (const dir of dirs) {
    const file = path.join(dir, 'SKILL.md');
    const rel = path.relative(ROOT, dir);
    assert.ok(existsSync(file), `missing SKILL.md in ${rel}`);
    const frontmatter = parseFrontmatter(readFileSync(file, 'utf-8'));
    assert.equal(frontmatter.name, path.basename(dir), `the name field in ${rel}/SKILL.md must match the directory`);
    assert.ok(
      typeof frontmatter.description === 'string' && frontmatter.description.length > 0,
      `missing description in ${rel}/SKILL.md`,
    );
  }
});

test('no markdown file under .agents uses an em dash', () => {
  // The vendored archify package (MIT, third-party) ships its own docs
  // under .agents/skills/archify/; the house prose rule covers files we
  // write, so only that subtree is exempt. Its SKILL.md is ours and stays
  // covered by the frontmatter test above.
  const vendoredRoot = path.join(AGENTS, 'skills', 'archify') + path.sep;
  const files = markdownFiles(AGENTS).filter((file) => !file.startsWith(vendoredRoot));
  assert.ok(files.length > 0, 'no markdown files found under .agents');
  for (const file of files) {
    const content = readFileSync(file, 'utf-8');
    assert.ok(
      !content.includes(EM_DASH),
      `em dash in ${path.relative(ROOT, file)}; rewrite with a comma, colon or period`,
    );
  }
});
