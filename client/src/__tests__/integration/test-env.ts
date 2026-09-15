import type { DeepServerTestEnv } from '@videodeck/test-infra/deepServerTestEnv';
import { createDeepServerTestEnv, folderConfig, videoFiles } from '@videodeck/test-infra/deepServerTestEnv';

// polish-ok: the seeded title is Polish on purpose — the search assertion
// proves the real analyzer folds diacritics (query 'gleboka' → 'Głęboka').
/**
 * Boots the REAL backend IN-PROCESS (vita-tracker style — no spawned
 * processes): the deep-server environment from @videodeck/test-infra imports
 * the real Express app after pointing it at the fake Elasticsearch, the mock
 * OpenAI server, the fake yt-dlp and a seeded temp folder. The only patch on
 * the client side is the fetch rewrite below.
 */

let env: DeepServerTestEnv | null = null;

export async function startBackend(): Promise<DeepServerTestEnv> {
  if (env) {
    return env;
  }
  env = await createDeepServerTestEnv({ listen: true });
  // Seed the channel folders the scenarios operate on (files the fake
  // yt-dlp would have produced) and point VIDEOS_FOLDER_PATH at them. Two
  // folders with different categories give the filter journeys something
  // to narrow by; the three first-channel videos have distinct dates and
  // view counts to filter and sort by.
  await env.seedFolder('channel-integration', {
    ...videoFiles('deepE2e0001', 'Głęboka integracja'),
    ...videoFiles('deepE2e0002', 'Historia kosmosu', {
      upload_date: '20260215',
      view_count: 99_000,
      like_count: 777,
    }),
    ...videoFiles('deepE2e0003', 'Nowoczesne kino', {
      upload_date: '20260320',
      view_count: 5_000,
      like_count: 12,
    }),
    'config.json': folderConfig('https://www.youtube.com/@integrationchannel'),
  });
  await env.seedFolder('channel-two', {
    ...videoFiles('deepE2e0004', 'Drugi kanał wideo', { channel: 'Drugi kanał' }),
    'config.json': folderConfig('https://www.youtube.com/@secondchannel', 'other'),
  });
  env.setFolders('channel-integration', 'channel-two');
  const baseUrl = env.baseUrl;
  if (!baseUrl) {
    throw new Error('the integration environment did not start an HTTP listener');
  }

  const originalFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = function integrationFetchProxy(
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url.startsWith('/api')) {
      return originalFetch(`${baseUrl}${url}`, init);
    }
    return originalFetch(input, init);
  } as typeof fetch;

  return env;
}

export async function stopBackend(): Promise<void> {
  if (!env) {
    return;
  }
  await env.dispose();
  env = null;
}
