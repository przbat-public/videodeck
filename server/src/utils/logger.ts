/**
 * Minimal application logger — the only module allowed to touch `console`
 * directly (the eslint override for this file disables `no-console`). Every
 * other module logs through it, so all output carries a timestamp and level.
 *
 * Methods call `console.*` lazily at call time, so `jest.spyOn(console, …)`
 * in tests keeps working. The level is read from `LOG_LEVEL` on every call
 * (`info` by default, then `warn`, `error`, `silent`).
 */

export type LogLevel = 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { info: 1, warn: 2, error: 3 };

/** `[2026-09-13T07:15:00.000Z] [INFO] message` */
export function formatLogLine(level: LogLevel, message: string): string {
  return `[${new Date().toISOString()}] [${level.toUpperCase()}] ${message}`;
}

function currentLevel(): number {
  const value = process.env.LOG_LEVEL;
  if (value === 'silent') {
    return Number.POSITIVE_INFINITY;
  }
  return LEVEL_ORDER[value as LogLevel] ?? LEVEL_ORDER.info;
}

export const logger = {
  info(message: string, ...args: unknown[]): void {
    if (currentLevel() <= LEVEL_ORDER.info) {
      console.log(formatLogLine('info', message), ...args);
    }
  },
  warn(message: string, ...args: unknown[]): void {
    if (currentLevel() <= LEVEL_ORDER.warn) {
      console.warn(formatLogLine('warn', message), ...args);
    }
  },
  error(message: string, ...args: unknown[]): void {
    if (currentLevel() <= LEVEL_ORDER.error) {
      console.error(formatLogLine('error', message), ...args);
    }
  },
};
