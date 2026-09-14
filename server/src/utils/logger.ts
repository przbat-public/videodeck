/**
 * Minimal application logger — the only module allowed to touch `console`
 * directly (the eslint override for this file disables `no-console`). Every
 * other module logs through it, so all output carries a timestamp and level.
 *
 * Methods call `console.*` lazily at call time, so `jest.spyOn(console, …)`
 * in tests keeps working.
 */

export type LogLevel = 'info' | 'warn' | 'error';

/** `[2026-09-13T07:15:00.000Z] [INFO] message` */
export function formatLogLine(level: LogLevel, message: string): string {
  return `[${new Date().toISOString()}] [${level.toUpperCase()}] ${message}`;
}

export const logger = {
  info(message: string, ...args: unknown[]): void {
    console.log(formatLogLine('info', message), ...args);
  },
  warn(message: string, ...args: unknown[]): void {
    console.warn(formatLogLine('warn', message), ...args);
  },
  error(message: string, ...args: unknown[]): void {
    console.error(formatLogLine('error', message), ...args);
  },
};
