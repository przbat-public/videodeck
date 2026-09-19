import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkJson, composeReport, parseAudit, parseOutdated } from './dependency-report.mjs';

test('parseOutdated maps pnpm outdated JSON to sorted rows', () => {
  const json = JSON.stringify({
    zod: { current: '3.25.76', wanted: '3.25.76', latest: '4.0.0' },
    express: { current: '5.0.0', wanted: '5.0.1', latest: '5.1.0' },
  });
  assert.deepEqual(parseOutdated(json), [
    { package: 'express', current: '5.0.0', wanted: '5.0.1', latest: '5.1.0' },
    { package: 'zod', current: '3.25.76', wanted: '3.25.76', latest: '4.0.0' },
  ]);
});

test('parseOutdated tolerates an empty result object', () => {
  assert.deepEqual(parseOutdated('{}'), []);
});

test('checkJson accepts a JSON answer and rejects everything else', () => {
  assert.deepEqual(checkJson({ stdout: '{"a":1}', stderr: '', failed: true }), { ok: true });
  // The failing command is the interesting case: its empty output used to be
  // read as "nothing found", which is how the report claimed 0 vulns for a
  // repository whose audit never ran.
  assert.deepEqual(checkJson({ stdout: '', stderr: 'ERR_PNPM_NO_LOCKFILE  Cannot audit\nmore', failed: true }), {
    ok: false,
    error: 'ERR_PNPM_NO_LOCKFILE  Cannot audit',
  });
  assert.deepEqual(checkJson({ stdout: 'not json', stderr: '', failed: true }), {
    ok: false,
    error: 'unreadable output: not json',
  });
});

test('parseAudit counts vulnerabilities by severity', () => {
  const json = JSON.stringify({
    metadata: { vulnerabilities: { low: 2, moderate: 1, high: 3, critical: 0 } },
  });
  assert.deepEqual(parseAudit(json), {
    low: 2,
    moderate: 1,
    high: 3,
    critical: 0,
    total: 6,
  });
});

test('parseAudit tolerates missing metadata', () => {
  assert.deepEqual(parseAudit('{}'), {
    low: 0,
    moderate: 0,
    high: 0,
    critical: 0,
    total: 0,
  });
});

test('composeReport renders a Markdown section per package', () => {
  const report = composeReport('2026-01-19', [
    {
      name: 'server',
      outdated: [{ package: 'express', current: '5.0.0', wanted: '5.0.1', latest: '5.1.0' }],
      outdatedError: null,
      audit: { low: 0, moderate: 1, high: 0, critical: 0, total: 1 },
      auditError: null,
    },
    {
      name: 'client',
      outdated: [],
      outdatedError: null,
      audit: { low: 0, moderate: 0, high: 0, critical: 0, total: 0 },
      auditError: null,
    },
  ]);

  assert.match(report, /# Dependency report — 2026-01-19/);
  assert.match(report, /## server/);
  assert.match(report, /\| `express` \| `5\.0\.0` \| `5\.0\.1` \| `5\.1\.0` \|/);
  assert.match(report, /Audit: 1 vuln \(low 0, moderate 1, high 0, critical 0\)/);
  assert.match(report, /Outdated: none\./);
  assert.match(report, /Audit: 0 vulns/);
});

test('composeReport says so when a command could not run', () => {
  const report = composeReport('2026-01-19', [
    {
      name: 'root',
      outdated: [],
      outdatedError: 'ERR_PNPM_NO_LOCKFILE  Cannot audit',
      audit: { low: 0, moderate: 0, high: 0, critical: 0, total: 0 },
      auditError: 'ERR_PNPM_NO_LOCKFILE  Cannot audit',
    },
  ]);

  assert.match(report, /Outdated: could not run \(ERR_PNPM_NO_LOCKFILE {2}Cannot audit\)\./);
  assert.match(report, /Audit: could not run \(ERR_PNPM_NO_LOCKFILE {2}Cannot audit\)\./);
  // The failure must never be dressed up as a clean result.
  assert.doesNotMatch(report, /Audit: 0 vulns/);
});
