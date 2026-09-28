/**
 * What counts as a configured API token.
 *
 * `docker-compose.yml` renders `API_TOKEN=${API_TOKEN:-}`, so an unset variable
 * reaches the server as an empty string, and a value of spaces is nobody's
 * secret. Every reader has to agree that blank means missing: otherwise the
 * boot check that refuses an unauthenticated API on a public interface sees a
 * "configured" token and the server serves every request instead.
 */
export function readApiToken(value: string | undefined): string | undefined {
  const trimmed = value?.trim() ?? '';
  return trimmed.length > 0 ? trimmed : undefined;
}
