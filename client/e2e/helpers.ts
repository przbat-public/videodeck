import type { Page } from '@playwright/test';

/** One video for the mocked search responses */
export interface E2eVideo {
  baseName: string;
  title: string;
  description?: string;
  videoPath: string;
  thumbnailPath: string;
  folderPath: string;
  videoId?: string;
  subtitlePath?: string;
  comments?: unknown[];
}

export const video = (
  baseName: string,
  title: string,
  overrides: Partial<E2eVideo> = {}
): E2eVideo => ({
  baseName,
  title,
  description: 'A description',
  videoPath: `${baseName}.mp4`,
  thumbnailPath: `${baseName}.webp`,
  folderPath: '/videos/e2e',
  comments: [],
  ...overrides,
});

/** JSON response helper */
export const json = (body: unknown, status = 200) => ({
  status,
  contentType: 'application/json',
  body: JSON.stringify(body),
});

/**
 * Stub every /api call the client makes. `search` receives the parsed query
 * params and returns the response body; details/categories/list are static.
 * Routes are registered on the browser context, so popups (the video card
 * opens a new tab) inherit them too.
 */
export async function mockApi(
  page: Page,
  handlers: {
    search?: (params: URLSearchParams) => unknown;
    categories?: string[];
    details?: unknown;
    status?: unknown;
  } = {}
): Promise<void> {
  const context = page.context();
  await context.route('**/api/videos/search**', async (route) => {
    const url = new URL(route.request().url());
    const body = handlers.search?.(url.searchParams) ?? { videos: [], totalCount: 0 };
    await route.fulfill(json(body));
  });
  await context.route('**/api/videos/categories', (route) =>
    route.fulfill(json({ categories: handlers.categories ?? ['fpv', 'lego'] }))
  );
  await context.route('**/api/videos/**/details', async (route) => {
    const body = handlers.details ?? {
      details: {
        title: 'Szczegóły filmu',
        description: 'Opis testowy',
        uploadDate: '20240615',
        duration: '10:30',
        viewCount: 1234,
        likeCount: 56,
        channelName: 'Kanał E2E',
        comments: [],
        commentCount: 0,
        videoPath: 'hedgehogs.mp4',
        thumbnailPath: 'hedgehogs.webp',
        folderPath: '/videos/e2e',
      },
    };
    await route.fulfill(json(body));
  });
  await context.route('**/api/videos/**/summary', (route) =>
    route.fulfill(json({ summary: 'Streszczenie E2E' }))
  );
  await context.route('**/api/status', (route) =>
    route.fulfill(
      json(
        handlers.status ?? {
          videosFolderPath: ['/videos/e2e'],
          folderConfigs: { '/videos/e2e': { channelUrl: 'https://yt/@e2e', category: 'fpv' } },
          downloadDefaults: { maxHeight: 2160, subLangs: ['en'], writeComments: true },
          indexedFolders: ['/videos/e2e'],
          status: 'ok',
        }
      )
    )
  );
  // list-exists and list calls used by the status page's folder section
  await context.route('**/api/folder/list-exists**', (route) =>
    route.fulfill(json({ exists: false }))
  );
  await context.route('**/api/folder/list**', (route) =>
    route.fulfill(
      json({
        videos: [],
        downloadStatuses: {},
        lastUpdatedDates: {},
      })
    )
  );
  // the download queue hook polls while it thinks jobs may exist
  await context.route('**/api/folder/queue*', (route) =>
    route.request().method() === 'GET'
      ? route.fulfill(json({ jobs: [] }))
      : route.fulfill(json({ jobs: [], skipped: [] }))
  );
}
