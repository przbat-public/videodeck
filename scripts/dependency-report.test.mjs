import assert from 'node:assert/strict';
import { test } from 'node:test';
import { composeReport, parseAudit, parseOutdated } from './dependency-report.mjs';

test('parseOutdated maps npm outdated JSON to sorted rows', () => {
  const json = JSON.stringify({
    zod: { current: '3.25.76', wanted: '3.25.76', latest: '4.0.0' },
    express: { current: '5.0.0', wanted: '5.0.1', latest: '5.1.0' },
  });
  assert.deepEqual(parseOutdated(json), [
    { package: 'express', current: '5.0.0', wanted: '5.0.1', latest: '5.1.0' },
    { package: 'zod', current: '3.25.76', wanted: '3.25.76', latest: '4.0.0' },
  ]);
});

test('parseOutdated treats empty/invalid input as no outdated packages', () => {
  assert.deepEqual(parseOutdated('{}'), []);
  assert.deepEqual(parseOutdated(''), []);
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
      audit: { low: 0, moderate: 1, high: 0, critical: 0, total: 1 },
    },
    {
      name: 'client',
      outdated: [],
      audit: { low: 0, moderate: 0, high: 0, critical: 0, total: 0 },
    },
  ]);

  assert.match(report, /# Dependency report — 2026-01-19/);
  assert.match(report, /## server/);
  assert.match(report, /\| `express` \| `5\.0\.0` \| `5\.0\.1` \| `5\.1\.0` \|/);
  assert.match(report, /Audit: 1 vuln \(low 0, moderate 1, high 0, critical 0\)/);
  assert.match(report, /Outdated: none\./);
  assert.match(report, /Audit: 0 vulns/);
});
