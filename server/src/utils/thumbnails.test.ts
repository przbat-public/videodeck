import { findThumbnailFile } from './thumbnails';

describe('findThumbnailFile', () => {
  it('takes the plain sidecar, .webp first, whatever the listing order or the case', () => {
    expect(findThumbnailFile('X', ['X.png', 'X.jpg', 'X.webp'])).toBe('X.webp');
    expect(findThumbnailFile('X', ['X.png', 'X.JPEG'])).toBe('X.JPEG');
    expect(findThumbnailFile('X', ['X.mp4', 'X.PNG'])).toBe('X.PNG');
  });

  it('prefers a plain sidecar to any numbered variant', () => {
    expect(findThumbnailFile('X', ['X.mp4_9.webp', 'X.7.jpg', 'X.png'])).toBe('X.png');
  });

  it('takes the highest numbered variant in either naming yt-dlp has used', () => {
    expect(findThumbnailFile('X', ['X.mp4_0.jpg', 'X.mp4_3.webp', 'X.mp4_12.jpg'])).toBe('X.mp4_12.jpg');
    expect(findThumbnailFile('X', ['X.2.webp', 'X.10.png', 'X.mp4_4.jpg'])).toBe('X.10.png');
  });

  it("never takes another video's images or a file that is no image", () => {
    expect(findThumbnailFile('X', ['X_extra.mp4_4.webp', 'X2.webp', 'XY.png'])).toBeUndefined();
    expect(findThumbnailFile('X', ['X.mp4', 'X.info.json', 'X.en.vtt', 'X.en.png', 'X.description'])).toBeUndefined();
  });

  it('never takes the image of a sibling video whose stem looks like a size', () => {
    // Restricted names keep a title's dot, so "Part 1.5" is a video of its own
    // beside "Part 1", and its plain thumbnail reads like a numbered variant
    const files = [
      '20200101_Part_1.info.json',
      '20200101_Part_1.mp4',
      '20200101_Part_1.5.info.json',
      '20200101_Part_1.5.mp4',
      '20200101_Part_1.5.webp',
    ];

    expect(findThumbnailFile('20200101_Part_1', files)).toBeUndefined();
    expect(findThumbnailFile('20200101_Part_1.5', files)).toBe('20200101_Part_1.5.webp');
    // A sibling with media and no info.json is a video all the same
    expect(findThumbnailFile('X', ['X.mp4', 'X.2.mkv', 'X.2.jpg'])).toBeUndefined();
  });

  it('reads any iterable of names, the folder index passes a set', () => {
    expect(findThumbnailFile('X', new Set(['X.mp4', 'X.jpg']))).toBe('X.jpg');
  });
});
