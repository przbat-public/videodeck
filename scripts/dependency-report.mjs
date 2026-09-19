/**
 * Weekly dependency report: `pnpm outdated` + `pnpm audit` for every package.
 *
 * Prints a Markdown report to stdout. Exit code is 0 even when outdated
 * packages or vulnerabilities are found — findings belong in the report, not
 * in the exit status. GitHub Actions turns the output into a labeled issue
 * (see .github/workflows/dependency-report.yml).
 *
 * The pnpm subprocesses run without installing anything: both commands read
 * `package.json` plus the workspace `pnpm-lock.yaml`. This repository has no
 * `package-lock.json`, which is why the report used to say "0 vulns" for
 * every package: `npm audit` failed outright and its empty output was read as
 * "nothing found". A command that cannot answer now says so in the report.
 */
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

/** @typedef {{ name: string, dir: string }} PackageSpec */
/** @typedef {{ package: string, current: string, wanted: string, latest: string }} OutdatedRow */
/** @typedef {{ low: number, moderate: number, high: number, critical: number, total: number }} AuditSummary */
/** @typedef {{ stdout: string, stderr: string, failed: boolean }} CommandOutput */
/** @typedef {{ name: string, outdated: OutdatedRow[], outdatedError: string | null, audit: AuditSummary, auditError: string | null }} PackageReport */

/** @type {PackageSpec[]} */
const PACKAGES = [
  { name: 'root', dir: '.' },
  { name: 'server', dir: 'server' },
  { name: 'client', dir: 'client' },
  { name: 'chrome-extension', dir: 'chrome-extension' },
];

const NO_VULNERABILITIES = { low: 0, moderate: 0, high: 0, critical: 0, total: 0 };

/**
 * First non-empty line of a command's diagnostics, for a one-line report
 * @param {string} text
 * @returns {string | undefined}
 */
function firstLine(text) {
  return text
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line !== '');
}

/**
 * Run a pnpm command. Both commands this script uses report findings through
 * a non-zero exit code as well as through their JSON (`pnpm outdated` exits 1
 * when anything is outdated, `pnpm audit` when vulnerabilities exist), so the
 * exit status alone is not an error — the output is what decides.
 * @param {string} dir
 * @param {string[]} args
 * @returns {CommandOutput}
 */
export function runPnpm(dir, args) {
  try {
    const stdout = execFileSync('pnpm', args, {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { stdout, stderr: '', failed: false };
  } catch (error) {
    const failed = /** @type {{ stdout?: string, stderr?: string }} */ (error);
    return { stdout: failed.stdout ?? '', stderr: failed.stderr ?? '', failed: true };
  }
}

/**
 * Whether the command answered with JSON, and why not when it did not. An
 * empty or non-JSON answer is a failure of the command (missing binary,
 * missing lockfile, no network), never "nothing found".
 * @param {CommandOutput} output
 * @returns {{ ok: true } | { ok: false, error: string }}
 */
export function checkJson(output) {
  const text = output.stdout.trim();
  if (text === '') {
    return { ok: false, error: firstLine(output.stderr) ?? 'the command produced no output' };
  }
  try {
    JSON.parse(text);
    return { ok: true };
  } catch {
    return { ok: false, error: `unreadable output: ${firstLine(text) ?? ''}` };
  }
}

/**
 * Parse `pnpm outdated --json` output into sorted rows.
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
 * Parse `pnpm audit --json` output into a severity summary.
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

    if (pkg.outdatedError !== null) {
      lines.push(`Outdated: could not run (${pkg.outdatedError}).`);
      lines.push('');
    } else if (pkg.outdated.length === 0) {
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

    if (pkg.auditError !== null) {
      // A command that failed is not a clean bill of health: say so instead
      // of printing the zero counts an empty answer would produce.
      lines.push(`Audit: could not run (${pkg.auditError}).`);
      lines.push('');
      continue;
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
 * Collect live data for every package. Outdated packages are per package;
 * the audit reads the one workspace lockfile, so it repeats the same numbers,
 * but each section stays self-contained.
 * @returns {PackageReport[]}
 */
export function collectReports() {
  return PACKAGES.map(({ name, dir }) => {
    const outdated = runPnpm(dir, ['outdated', '--json']);
    const audit = runPnpm(dir, ['audit', '--json']);
    const outdatedCheck = checkJson(outdated);
    const auditCheck = checkJson(audit);
    return {
      name,
      outdated: outdatedCheck.ok ? parseOutdated(outdated.stdout) : [],
      outdatedError: outdatedCheck.ok ? null : outdatedCheck.error,
      audit: auditCheck.ok ? parseAudit(audit.stdout) : NO_VULNERABILITIES,
      auditError: auditCheck.ok ? null : auditCheck.error,
    };
  });
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const date = new Date().toISOString().slice(0, 10);
  process.stdout.write(composeReport(date, collectReports()));
}
