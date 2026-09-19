import { describe, expect, it } from 'vitest';
import { formatAge, formatUploadDate, isOlderThanMonth } from './videoDates';

describe('videoDates', () => {
  it('formats an 8-digit upload date as ISO', () => {
    expect(formatUploadDate('20231201')).toBe('2023-12-01');
  });

  it('passes anything else through unchanged', () => {
    expect(formatUploadDate('2023120')).toBe('2023120');
    expect(formatUploadDate('2023-12-01')).toBe('2023-12-01');
  });

  it('treats missing or unparseable dates as older than a month', () => {
    expect(isOlderThanMonth(undefined)).toBe(true);
    expect(isOlderThanMonth('not-a-date')).toBe(true);
  });

  it('is false for recent dates and true for stale ones', () => {
    const now = Date.parse('2026-06-01T00:00:00.000Z');
    expect(isOlderThanMonth('2026-05-20T00:00:00.000Z', now)).toBe(false);
    expect(isOlderThanMonth('2026-01-01T00:00:00.000Z', now)).toBe(true);
  });
  it('formats the age of an update in the UI language', () => {
    const now = Date.parse('2026-09-19T12:00:00.000Z');

    expect(formatAge('2026-09-19T09:00:00.000Z', 'pl', now)).toBe('dzisiaj');
    expect(formatAge('2026-09-18T12:00:00.000Z', 'pl', now)).toBe('wczoraj');
    expect(formatAge('2026-09-16T12:00:00.000Z', 'pl', now)).toBe('3 dni temu');
    expect(formatAge('2026-09-18T12:00:00.000Z', 'en', now)).toBe('yesterday');
  });

  it('renders nothing for a missing or unparseable date', () => {
    expect(formatAge(undefined, 'pl')).toBe('');
    expect(formatAge('not-a-date', 'pl')).toBe('');
  });
});
