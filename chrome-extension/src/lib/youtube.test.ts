import { describe, expect, it } from 'vitest';
import { getYouTubeVideoId } from './youtube';

describe('getYouTubeVideoId', () => {
  it('reads the id from a watch URL', () => {
    expect(getYouTubeVideoId('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
  });

  it('reads the id from a youtu.be URL', () => {
    expect(getYouTubeVideoId('https://youtu.be/dQw4w9WgXcQ?t=42')).toBe('dQw4w9WgXcQ');
  });

  it('reads the id from embed and /v/ URLs', () => {
    expect(getYouTubeVideoId('https://www.youtube.com/embed/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
    expect(getYouTubeVideoId('https://www.youtube.com/v/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
  });

  it('keeps working when the URL carries extra query parameters', () => {
    expect(getYouTubeVideoId('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=1s&list=abc')).toBe(
      'dQw4w9WgXcQ'
    );
  });

  it('returns null for URLs without a video id', () => {
    expect(getYouTubeVideoId('https://www.youtube.com/')).toBeNull();
    expect(getYouTubeVideoId('https://www.youtube.com/@somechannel')).toBeNull();
    expect(getYouTubeVideoId('https://example.com/page')).toBeNull();
  });

  it('rejects ids that are not 11 characters long', () => {
    expect(getYouTubeVideoId('https://youtu.be/short')).toBeNull();
  });
});
