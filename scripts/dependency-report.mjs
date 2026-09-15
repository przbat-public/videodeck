/**
 * Weekly dependency report: `npm outdated` + `npm audit` for every package.
 *
 * Prints a Markdown report to stdout. Exit code is 0 even when outdated
 * packages or vulnerabilities are found — findings belong in the report, not
 * in the exit status. GitHub Actions turns the output into a labeled issue
 * (see .github/workflows/dependency-report.yml).
 *
 * The npm subprocesses run without installing anything: both commands only
 * need `package.json` + `package-lock.json` from the repository.
 */
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

/** @typedef {{ name: string, dir: string }} PackageSpec */
/** @typedef {{ package: string, current: string, wanted: string, latest: string }} OutdatedRow */
/** @typedef {{ low: number, moderate: number, high: number, critical: number, total: number }} AuditSummary */

/** @type {PackageSpec[]} */
const PACKAGES = [
  { name: 'root', dir: '.' },
  { name: 'server', dir: 'server' },
  { name: 'client', dir: 'client' },
  { name: 'chrome-extension', dir: 'chrome-extension' },
];

/**
 * Run an npm command that uses a non-zero exit code to signal findings
 * (`npm outdated` exits 1 when anything is outdated, `npm audit` when
 * vulnerabilities exist). Both outcomes are normal here.
 * @param {string} dir
 * @param {string[]} args
 * @returns {string} stdout, even when the command failed
 */
export function runNpm(dir, args) {
  try {
    return execFileSync('npm', args, {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const failed = /** @type {{ stdout?: string, stderr?: string }} */ (error);
    return failed.stdout ?? '';
  }
}

/**
 * Parse `npm outdated --json` output into sorted rows.
 * @param {string} json
 * @returns {OutdatedRow[]}
 */
export function parseOutdated(json) {
  /** @type {Record<string, { current?: string, wanted?: string, latest?: string }>} */
  const parsed = JSON.parse(json || '{}');
  return Object.entries(parsed)
    .map(([packageName, info]) => ({
      package: packageName,
      current: info.current ?? '?',
      wanted: info.wanted ?? '?',
      latest: info.latest ?? '?',
    }))
    .sort((a, b) => a.package.localeCompare(b.package));
}

/**
 * Parse `npm audit --json` output into a severity summary.
 * @param {string} json
 * @returns {AuditSummary}
 */
export function parseAudit(json) {
  /** @type {{ metadata?: { vulnerabilities?: Record<string, number> } }} */
  const parsed = JSON.parse(json || '{}');
  const counts = parsed.metadata?.vulnerabilities ?? {};
  const low = counts.low ?? 0;
  const moderate = counts.moderate ?? 0;
  const high = counts.high ?? 0;
  const critical = counts.critical ?? 0;
  return { low, moderate, high, critical, total: low + moderate + high + critical };
}

/** @typedef {{ name: string, outdated: OutdatedRow[], audit: AuditSummary }} PackageReport */

/**
 * @param {string} date
 * @param {PackageReport[]} packages
 * @returns {string} Markdown report
 */
export function composeReport(date, packages) {
  const lines = [
    `# Dependency report — ${date}`,
    '',
    '> Auto-generated weekly by',
    '> [`.github/workflows/dependency-report.yml`](.github/workflows/dependency-report.yml).',
    '>',
    '> * **Outdated** — a newer version exists on the registry.',
    '> * **Audit** — known vulnerabilities in the lockfile tree.',
    '>',
    '> Close this issue when the findings have been handled; the next run',
    '> creates a fresh one.',
    '',
  ];

  for (const pkg of packages) {
    lines.push(`## ${pkg.name}`);
    lines.push('');

    if (pkg.outdated.length === 0) {
      lines.push('Outdated: none.');
      lines.push('');
    } else {
      lines.push('### Outdated packages');
      lines.push('');
      lines.push('| package | current | wanted | latest |');
      lines.push('| --- | --- | --- | --- |');
      for (const row of pkg.outdated) {
        lines.push(`| \`${row.package}\` | \`${row.current}\` | \`${row.wanted}\` | \`${row.latest}\` |`);
      }
      lines.push('');
    }

    const { low, moderate, high, critical, total } = pkg.audit;
    lines.push(
      `Audit: ${total} vuln${total === 1 ? '' : 's'} (low ${low}, moderate ${moderate}, high ${high}, critical ${critical}).`,
    );
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Collect live data for every package.
 * @returns {PackageReport[]}
 */
export function collectReports() {
  return PACKAGES.map(({ name, dir }) => ({
    name,
    outdated: parseOutdated(runNpm(dir, ['outdated', '--json'])),
    audit: parseAudit(runNpm(dir, ['audit', '--json'])),
  }));
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const date = new Date().toISOString().slice(0, 10);
  process.stdout.write(composeReport(date, collectReports()));
}
