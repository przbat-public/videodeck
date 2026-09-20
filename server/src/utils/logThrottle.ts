/**
 * One line per window for a failure that repeats on every request. A stopped
 * Elasticsearch fails `/api/status`, `/api/videos/channels`, every search and
 * each health poll; printing the full stack for each of them buries the one
 * line that matters.
 */
export class LogThrottle {
  private lastLoggedAt: number | null = null;

  constructor(private readonly windowMs: number) {}

  /** True when this occurrence should be printed (the first one in a window) */
  shouldLog(now: number = Date.now()): boolean {
    if (this.lastLoggedAt !== null && now - this.lastLoggedAt < this.windowMs) {
      return false;
    }
    this.lastLoggedAt = now;
    return true;
  }

  /** Forget the window, so the next occurrence logs again */
  reset(): void {
    this.lastLoggedAt = null;
  }
}

/** Longest error text worth printing in a throttled line */
const ERROR_TEXT_LIMIT = 200;

/**
 * One compact description of a failure: the wrapped causes of an Elasticsearch
 * connection error carry the same socket message three times over.
 */
export function describeError(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current instanceof Error; depth += 1) {
    const text = `${current.name}: ${current.message}`.trim();
    if (!parts.includes(text)) {
      parts.push(text);
    }
    current = current.cause;
  }
  const described = parts.join(' <- ');
  return described.length > ERROR_TEXT_LIMIT ? `${described.slice(0, ERROR_TEXT_LIMIT)}...` : described;
}
