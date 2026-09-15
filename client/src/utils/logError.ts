/**
 * Single console error reporter for the client. Biome's noConsole rule is
 * disabled for this file only — every other module logs through here.
 */
export function logError(error: unknown): void {
  console.error(error);
}
