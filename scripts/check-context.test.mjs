import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// Keeps the agent-facing context honest, Ctxlint style: every command
// AGENTS.md tells an agent to run must exist in a workspace package.json,
// every repo path it references must exist, the Skills list must match the
// skill directories, and none of our own docs may still say npm/npx where
// the repo uses pnpm. Vendored third-party files are exempt.
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const AGENTS = path.join(ROOT, 'AGENTS.md');
const WORKSPACES = ['server', 'client', 'chrome-extension'];
const VENDORED = [path.join('.agents', 'skills', 'archify'), path.join('scripts', 'humanizer')];

/**
 * @returns {string[]}
 */
const ourDocs = () => {
  /** @type {string[]} */
  const out = [];
  for (const dir of ['.', 'docs', 'chrome-extension', '.agents', '.github']) {
    walk(path.join(ROOT, dir), out);
  }
  return out.filter((file) => !VENDORED.some((v) => file.includes(`${path.sep}${v}${path.sep}`)));
};

/**
 * @param {string} dir
 * @param {string[]} out
 */
const walk = (dir, out) => {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      if (entry === 'node_modules' || entry === 'screenshots') continue;
      walk(full, out);
    } else if (entry.endsWith('.md') && !entry.startsWith('README_')) {
      out.push(full);
    }
  }
};

/**
 * @param {string} file
 * @returns {Record<string, string>}
 */
const readScripts = (file) => JSON.parse(readFileSync(file, 'utf-8')).scripts ?? {};

/**
 * @param {string} content
 * @returns {Array<{ scope: string; name: string; raw: string }>}
 */
const referencedCommands = (content) => {
  const out = [];
  const re =
    /(?:cd\s+(\S+)\s+&&\s+)?pnpm\s+run\s+([a-z0-9:_-]+)|(?:cd\s+(\S+)\s+&&\s+)?pnpm\s+(test|install|typecheck)\b(?![\s:-])/g;
  for (const match of content.matchAll(re)) {
    const scope = match[1] ?? match[3] ?? 'root';
    const name = match[2] ?? match[4];
    if (name !== undefined) out.push({ scope, name, raw: match[0] });
  }
  return out;
};

test('every pnpm command AGENTS.md references exists in that workspace', () => {
  const content = readFileSync(AGENTS, 'utf-8');
  const scripts = new Map([['root', readScripts(path.join(ROOT, 'package.json'))]]);
  for (const ws of WORKSPACES) {
    scripts.set(ws, readScripts(path.join(ROOT, ws, 'package.json')));
  }
  const commands = referencedCommands(content);
  assert.ok(commands.length > 0, 'no pnpm commands found in AGENTS.md');
  for (const command of commands) {
    const available = scripts.get(command.scope) ?? null;
    assert.ok(available !== null, `unknown workspace ${command.scope} in AGENTS.md command: ${command.raw}`);
    assert.ok(
      command.name in available,
      `AGENTS.md references ${command.raw}, but ${command.scope === 'root' ? 'the root package.json' : `${command.scope}/package.json`} has no "${command.name}" script`,
    );
  }
});

/**
 * @param {string} token
 * @returns {boolean}
 */
const isRepoPath = (token) => {
  if (!token.includes('/')) return false;
  if (token.includes('*') || token.includes(' ') || token.includes('\\')) return false;
  if (/^[@^?:/]/.test(token)) return false;
  if (token.endsWith('.env') || token.includes('.queue-state')) return false;
  if (token.startsWith('node_modules') || token.startsWith('pnpm')) return false;
  return true;
};

test('every repo path AGENTS.md references exists', () => {
  const content = readFileSync(AGENTS, 'utf-8');
  const checked = [];
  for (const match of content.matchAll(/`([^`\n]+)`/g)) {
    const token = match[1];
    if (token === undefined || !isRepoPath(token)) continue;
    const target = path.join(ROOT, token);
    assert.ok(existsSync(target), `AGENTS.md references ${token}, which does not exist in the repo`);
    checked.push(token);
  }
  assert.ok(checked.length > 0, 'no repo paths found in AGENTS.md');
});

test('the Skills list in AGENTS.md matches the skill directories', () => {
  const content = readFileSync(AGENTS, 'utf-8');
  const section = content.split('## Skills')[1]?.split('## ')[0] ?? '';
  const listed = [...section.matchAll(/^- `([a-z0-9-]+)`/gm)].map((m) => m[1]);
  const dirs = readdirSync(path.join(ROOT, '.agents', 'skills'));
  assert.deepEqual([...listed].sort(), [...dirs].sort(), 'AGENTS.md Skills list and .agents/skills/ drifted apart');
});

test('none of our docs still use npm or npx commands', () => {
  const banned = /\b(?:npm|npx)\s+(?:run|test|install|ci|exec|publish|link|start)\b/g;
  for (const file of ourDocs()) {
    const content = readFileSync(file, 'utf-8');
    const match = banned.exec(content);
    assert.equal(
      match,
      null,
      `${path.relative(ROOT, file)} still uses ${match === null ? '' : match[0]}; the repo uses pnpm`,
    );
  }
});
