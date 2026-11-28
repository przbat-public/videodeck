import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// The server image keeps two promises in shell lines that no unit test reads.
// Its runtime install holds the server's production closure, not the client's
// packages or the test tooling. And yt-dlp arrives with the pinned extras the
// folder options rely on: curl_cffi for `impersonate: true`, yt-dlp-ejs and a
// deno runtime for the scripts YouTube makes a client solve, from a release
// past the pin sets with published advisories. The integration job in CI
// installs the same yt-dlp, so it reads both values from the Dockerfile
// instead of repeating them.
//
// The docker-images job checks the built image itself. This file is the part
// of that promise a machine without Docker can check. Parsed with regular
// expressions, like the compose check: the Dockerfile is ours.
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DOCKERFILE = readFileSync(path.join(ROOT, 'server', 'Dockerfile'), 'utf8');
const CI = readFileSync(path.join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');

/**
 * The runtime stage line by line, each continuation line joined to the
 * instruction it continues.
 *
 * @returns {string[]}
 */
function runtimeLines() {
  const start = DOCKERFILE.search(/^FROM \S+ AS runtime\s*$/m);
  assert.notEqual(start, -1, 'server/Dockerfile has no `AS runtime` stage');
  return DOCKERFILE.slice(start).replace(/\\\n/g, ' ').split('\n');
}

/**
 * The value an `ARG <name>=<value>` line of the runtime stage sets, or
 * undefined when the stage sets none: an ARG of another stage does not
 * reach it.
 *
 * @param {string} name
 */
function runtimeArg(name) {
  const prefix = `ARG ${name}=`;
  return runtimeLines()
    .find((line) => line.startsWith(prefix))
    ?.slice(prefix.length)
    .trim();
}

test('the runtime install holds the server production closure only', () => {
  const install = runtimeLines().find((line) => /\bpnpm install\b/.test(line));
  assert.ok(install, 'the runtime stage no longer runs pnpm install');
  assert.match(install, /\s--prod\b/, 'the runtime install must leave devDependencies out (--prod)');
  // A plain --filter follows the server's devDependencies into test-infra,
  // and test-infra lists express and supertest as its own dependencies
  assert.match(
    install,
    /\s--filter-prod[= ]'?video-search-server\.\.\.'?(\s|$)/,
    'install the server and the workspace packages it runs on, production only: --filter-prod video-search-server...',
  );
  assert.match(install, /\s--fail-if-no-match\b/, 'a renamed package has to fail the build, not install nothing');
});

test('yt-dlp comes with the pinned extras the folder options need', () => {
  // Read from the runtime stage: set in the build stage, the ARG does not
  // reach the pip line below, `yt-dlp[]` reads as a bare yt-dlp, and pip
  // installs it without a word
  const extras = runtimeArg('YTDLP_EXTRAS')?.split(',') ?? [];
  // pin: the default dependencies at fixed versions, yt-dlp-ejs among them;
  // pin-curl-cffi: what --impersonate chrome loads; pin-deno: the runtime the
  // challenge scripts run in, which yt-dlp finds without a flag
  for (const extra of ['pin', 'pin-curl-cffi', 'pin-deno']) {
    assert.ok(
      extras.includes(extra),
      `ARG YTDLP_EXTRAS in the runtime stage of server/Dockerfile must include ${extra}`,
    );
  }
  const pip = runtimeLines().find((line) => /\bpip install\b/.test(line)) ?? '';
  assert.match(
    pip,
    /"yt-dlp\[\$\{YTDLP_EXTRAS\}\]==\$\{YTDLP_VERSION\}"/,
    'the pip install must ask for yt-dlp with the YTDLP_EXTRAS extras at YTDLP_VERSION',
  );
  // Wheels only: nothing builds from a source archive as root, and a platform
  // without a wheel fails the build with the package's name
  assert.match(pip, /\s--only-binary[= ]:all:(\s|$)/, 'the pip install must refuse source builds: --only-binary=:all:');
});

test('yt-dlp is pinned at 2026.10.26 or later, past the pin sets with published advisories', () => {
  // The pin extras hold every library at the version the release names, and
  // nothing bumps them for us: Dependabot reads npm and the workflows only.
  // 2026.10.26 is the first release past brotli 1.2.0 (CVE-2026-111497, an
  // out-of-bounds write in the decoder), certifi 2026.7.22
  // (GHSA-6q48-6c7w-9gw2, compromised intermediates, and yt-dlp trusts that
  // bundle alone) and urllib3 2.7.0, with curl_cffi 0.17.0, whose own copy of
  // brotli is 1.2.1 as well.
  const version = runtimeArg('YTDLP_VERSION') ?? '';
  const release = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  assert.ok(release, `the runtime stage must pin a yt-dlp release in ARG YTDLP_VERSION, not "${version}"`);
  const [year = 0, month = 0, day = 0] = release.slice(1).map(Number);
  assert.ok(
    year * 10_000 + month * 100 + day >= 20_261_026,
    `yt-dlp ${version} pins a brotli, a certifi or a urllib3 with a published advisory: pin 2026.10.26 or later`,
  );
});

test('the integration job installs the yt-dlp the image ships', () => {
  const install = CI.split('\n').find((line) => /\bpipx install\b/.test(line)) ?? '';
  assert.match(install, /yt-dlp\[/, 'ci.yml must install yt-dlp with its extras');
  assert.match(install, /ARG YTDLP_EXTRAS=/, 'ci.yml must read the extras from server/Dockerfile');
  assert.match(install, /ARG YTDLP_VERSION=/, 'ci.yml must read the version from server/Dockerfile');
});
