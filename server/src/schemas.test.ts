import {
  ChannelVideoSchema,
  CommentWithRepliesSchema,
  EnqueueJobsResponseSchema,
  QueueJobSchema,
  SearchResponseSchema,
  VideoCommentSchema,
  VideoDetailsResponseSchema,
} from '@shared/schemas';

/**
 * The schemas are the contract: this suite pins them against realistic
 * fixtures (real yt-dlp shapes) and representative API bodies.
 */

const videoComment = {
  id: 'Ugx1',
  text: 'Text',
  like_count: 3,
  author: 'FishFan',
  author_id: '@fishfan',
  author_is_uploader: false,
  author_is_verified: false,
  author_url: 'http://www.youtube.com/@fishfan',
  is_favorited: false,
  _time_text: '19 years ago',
  timestamp: 1146400000,
  is_pinned: false,
  parent: 'root',
};

const queueJob = {
  id: 'job-1',
  folderPath: '/videos/a',
  videoId: 'v1',
  videoUrl: 'https://yt/v1',
  type: 'download',
  status: 'running',
  log: ['[download] 10%'],
  logLineCount: 1,
  createdAt: '2025-01-01T00:00:00.000Z',
};

describe('fixture compatibility (real yt-dlp shapes)', () => {
  it('accepts the comment shape real info.json files carry', () => {
    expect(VideoCommentSchema.parse(videoComment)).toEqual(videoComment);
  });

  it('accepts flat list.json entries', () => {
    const entry = {
      id: 'yf__frUKreI',
      title: 'Walksnail Ascent Firmware Update How-To',
      url: 'https://www.youtube.com/watch?v=yf__frUKreI',
    };
    expect(ChannelVideoSchema.parse(entry)).toEqual(entry);
  });

  it('accepts a queue job snapshot', () => {
    expect(QueueJobSchema.parse(queueJob)).toEqual(queueJob);
  });
});

describe('response shapes', () => {
  it('accepts a search response', () => {
    const body = {
      videos: [
        {
          baseName: '20240101_Video',
          title: 'Title',
          description: 'Desc',
          videoPath: '20240101_Video.mp4',
          thumbnailPath: '20240101_Video.webp',
          folderPath: '/videos/a',
          comments: [],
        },
      ],
      totalCount: 1,
    };
    expect(SearchResponseSchema.parse(body)).toEqual(body);
  });

  it('accepts video details with a nested comment tree and passthrough extras', () => {
    const body = {
      details: {
        title: 'T',
        description: 'D',
        uploadDate: '20240101',
        duration: '1:00',
        viewCount: 1,
        likeCount: 0,
        channelName: 'C',
        comments: [
          {
            id: 'c1',
            text: 'root',
            like_count: 2,
            replies: [{ id: 'c2', text: 'reply', arbitrary_field: 'kept' }],
          },
        ],
        commentCount: 1,
        videoPath: 'v.mp4',
        thumbnailPath: 'v.webp',
        subtitles: [{ path: 'v.en.vtt', lang: 'en' }],
        folderPath: '/videos/a',
      },
    };
    const parsed = VideoDetailsResponseSchema.parse(body);
    expect(parsed.details.comments[0]?.replies?.[0]?.arbitrary_field).toBe('kept');
    expect(parsed.details.subtitles).toEqual([{ path: 'v.en.vtt', lang: 'en' }]);
  });

  it('accepts a nested comment tree', () => {
    const tree = { id: 'c1', text: 'root', replies: [{ id: 'c2', text: 'child' }] };
    expect(CommentWithRepliesSchema.parse(tree)).toEqual(tree);
  });

  it('accepts an enqueue response', () => {
    const body = { jobs: [queueJob], skipped: [{ videoId: 'x', reason: 'not downloaded' }] };
    expect(EnqueueJobsResponseSchema.parse(body)).toEqual(body);
  });

  it('rejects a search response with a wrong shape', () => {
    expect(() => SearchResponseSchema.parse({ videos: 'nope', totalCount: 0 })).toThrow();
  });
});
