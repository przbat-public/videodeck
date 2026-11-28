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
  // `npx <tool> <verb>` (like `npx playwright install`) is as banned as a
  // bare `npx run`: the repo uses pnpm for every tool invocation.
  const banned =
    /\b(?:npm|npx)\s+(?:(?:run|test|install|ci|exec|publish|link|start)\b|\S+\s+(?:install|run|exec|audit|update|outdated|publish)\b)/g;
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

test('every pnpm version our docs mention matches packageManager', () => {
  const packageJson = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf-8'));
  const version = String(packageJson.packageManager).split('@')[1];
  assert.ok(/^\d+\.\d+\.\d+$/.test(version ?? ''), 'packageManager is not a pinned pnpm version');
  for (const file of ourDocs()) {
    const content = readFileSync(file, 'utf-8');
    for (const match of content.matchAll(/pnpm (\d+\.\d+\.\d+)/g)) {
      assert.equal(
        match[1],
        version,
        `${path.relative(ROOT, file)} mentions pnpm ${match[1]}, but packageManager pins ${version}`,
      );
    }
  }
});

/**
 * A doc's text with every whitespace run folded to one space, so a phrase
 * that Markdown wraps across lines still matches as one.
 *
 * @param {string} file
 * @returns {string}
 */
const flatText = (file) => readFileSync(file, 'utf-8').replace(/\s+/g, ' ');

/** The CHANGELOG records the rules a release replaced, in the old words. */
const HISTORY = ['CHANGELOG.md'];

/**
 * Wording of the deny model that #128 replaced with ALLOWED_EXTRA_ARGS. yt-dlp
 * has no --load-cookies option at all: the name only ever lived in that list.
 */
const DENY_MODEL_WORDING = [
  /\bforbidden (?:yt-dlp )?flags?\b/i,
  /\bforbidden list\b/i,
  /\bforbidden\b[^.]{0,20}`--/i,
  /\bzabronione flagi\b/i,
  /--load-cookies\b/,
];

test('our docs describe the yt-dlp argument rule as the allowlist the code enforces', () => {
  // A denylist loses to yt-dlp's parser (--alias, clustered short options,
  // prefixes), so folderConfig.ts accepts exact names only. A doc that still
  // speaks of forbidden flags tells the reader every other flag gets through.
  const source = readFileSync(path.join(ROOT, 'server', 'src', 'services', 'folderConfig.ts'), 'utf-8');
  assert.match(
    source,
    /\bconst ALLOWED_EXTRA_ARGS\b/,
    'server/src/services/folderConfig.ts no longer defines ALLOWED_EXTRA_ARGS, which AGENTS.md and the security docs name',
  );
  assert.match(readFileSync(AGENTS, 'utf-8'), /`ALLOWED_EXTRA_ARGS`/, 'AGENTS.md no longer names ALLOWED_EXTRA_ARGS');
  /** @type {Set<string>} */
  const offenders = new Set();
  for (const file of ourDocs()) {
    const relative = path.relative(ROOT, file);
    if (HISTORY.includes(relative)) continue;
    const text = flatText(file);
    for (const pattern of DENY_MODEL_WORDING) {
      const match = pattern.exec(text);
      if (match !== null) offenders.add(`${relative}: "${match[0]}"`);
    }
  }
  assert.deepEqual(
    [...offenders],
    [],
    'these docs describe a yt-dlp flag denylist; only the exact names in ALLOWED_EXTRA_ARGS (server/src/services/folderConfig.ts) pass',
  );
});

test('no doc ties ALLOWED_HOSTS to outbound requests', () => {
  // ALLOWED_HOSTS only judges incoming requests: the Host guard in
  // server/src/app.ts and the Origin of an unmarked browser request in
  // server/src/routes/http.ts. The outbound rule is the YouTube check in
  // shared/youtube.ts.
  /** @type {Set<string>} */
  const offenders = new Set();
  for (const file of ourDocs()) {
    const relative = path.relative(ROOT, file);
    if (HISTORY.includes(relative)) continue;
    const match = /\boutbound\b[^.;]{0,80}ALLOWED_HOSTS/i.exec(flatText(file));
    if (match !== null) offenders.add(`${relative}: "${match[0]}"`);
  }
  assert.deepEqual(
    [...offenders],
    [],
    'these docs call ALLOWED_HOSTS an outbound check; it only judges incoming requests',
  );
});

test('the CORS_ORIGINS docs say a cross-site request stays refused', () => {
  // routes/http.ts answers 403 to a request marked Sec-Fetch-Site: cross-site
  // before it reads CORS_ORIGINS (#132), so a listed origin on another site
  // still fails. INSTALL.md once showed https://example.com as the example.
  /** @type {string[]} */
  const silent = [];
  for (const file of ['docs/INSTALL.md', 'server/.env.example']) {
    const lines = readFileSync(path.join(ROOT, file), 'utf-8').split('\n');
    const at = lines.findIndex((line) => line.includes('CORS_ORIGINS='));
    assert.ok(at >= 0, `${file} no longer documents CORS_ORIGINS`);
    let start = at;
    while (start > 0 && (lines[start - 1] ?? '').startsWith('#')) start -= 1;
    if (!/cross-site/i.test(lines.slice(start, at + 1).join(' '))) silent.push(file);
  }
  assert.deepEqual(
    silent,
    [],
    'these files document CORS_ORIGINS without saying that a cross-site request is refused even from a listed origin',
  );
});

test('every `symbol` in `path` a doc names is found in that file', () => {
  // The folder routes moved into server/src/routes/folder/, and the security
  // docs kept pointing at the old file. A reference that names its symbol can
  // be checked; a bare path only proves the file exists.
  /** @type {string[]} */
  const stale = [];
  let checked = 0;
  for (const file of ourDocs()) {
    const relative = path.relative(ROOT, file);
    if (HISTORY.includes(relative)) continue;
    for (const match of flatText(file).matchAll(/`([A-Za-z_]\w*)` in `([\w.-]+\/[\w./-]+\.[cm]?[jt]sx?)`/g)) {
      checked += 1;
      const [, symbol = '', target = ''] = match;
      const full = path.join(ROOT, target);
      if (!existsSync(full) || !readFileSync(full, 'utf-8').includes(symbol)) {
        stale.push(`${relative}: ${symbol} in ${target}`);
      }
    }
  }
  assert.ok(checked > 0, 'no doc names a `symbol` in `path`: the pattern no longer matches the docs');
  assert.deepEqual([...new Set(stale)], [], 'these docs name a symbol the file they point at does not contain');
});
