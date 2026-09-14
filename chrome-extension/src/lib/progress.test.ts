import { describe, expect, it } from 'vitest';
import { extractProgress } from './progress';

describe('extractProgress', () => {
  it('reads the percentage from a yt-dlp download line', () => {
    expect(extractProgress('[download]  45.2% of 123.45MiB at 1.23MiB/s ETA 00:45')).toBe(45.2);
  });

  it('reads integer percentages', () => {
    expect(extractProgress('[download] 100.0% of 10MiB')).toBe(100);
  });

  it('clamps values above 100', () => {
    expect(extractProgress('[download] 150% of 10MiB')).toBe(100);
  });

  it('clamps negative values to 0', () => {
    expect(extractProgress('[download] -5% of 10MiB')).toBe(0);
  });

  it('treats a "completed" message as 100%', () => {
    expect(extractProgress('Download completed')).toBe(100);
  });

  it('returns undefined for lines without a percentage', () => {
    expect(extractProgress('[info] Downloading webpage')).toBeUndefined();
    expect(extractProgress('')).toBeUndefined();
  });
});
