import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  ArchiveReconcileResponseSchema,
  FOLDER_UNAVAILABLE_CODE,
  FolderStateResponseSchema,
  VideoStateResponseSchema,
} from '@videodeck/shared/schemas';
import type { DeepServerTestEnv } from '@videodeck/test-infra/deepServerTestEnv';
import {
  createDeepServerTestEnv,
  folderConfig,
  incompleteVideoFiles,
  videoFiles,
} from '@videodeck/test-infra/deepServerTestEnv';

/**
 * The folder state and archive reconcile routes over real temp folders: the
 * real folder index, the real archive.txt and the real mount guard. Nothing
 * here mocks a server module, and every archive check reads the file back, so
 * a route that answers right while the disk says otherwise fails here.
 *
 * The environment is shared by the whole file: each test seeds a folder
 * under its own name.
 */
describe('folder state over real folders', () => {
  let env: DeepServerTestEnv;

  beforeAll(async () => {
    env = await createDeepServerTestEnv();
  });

  afterAll(async () => {
    await env.dispose();
  });

  /** archive.txt as the next yt-dlp run in the folder reads it */
  const archiveOf = (folderPath: string): Promise<string> => readFile(path.join(folderPath, 'archive.txt'), 'utf-8');

  /**
   * A channel folder whose one listed video is on disk without the Polish
   * subtitles its config asks for, next to a video the channel no longer lists
   */
  async function seedStateFolder(name: string): Promise<string> {
    const folderPath = await env.seedFolder(name, {
      ...incompleteVideoFiles('aaaaaaaaaaa', 'Kept'),
      ...videoFiles('deleted0001', 'Deleted'),
    });
    env.setFolders(name);
    return folderPath;
  }

  describe('folder state', () => {
    it('reports what each video has, what it misses and which videos only exist on disk', async () => {
      const folderPath = await seedStateFolder('state-gaps');

      const response = await env.agent.get('/api/folder/state').query({ folderPath });

      expect(response.status).toBe(200);
      const body = FolderStateResponseSchema.parse(response.body);
      expect(body.videos).toHaveLength(1);
      expect(body.videos[0]).toMatchObject({
        id: 'aaaaaaaaaaa',
        downloadState: {
          files: { video: true, thumbnail: true, description: true, subLangs: ['en'], comments: true },
          // The Polish subtitle is the gap, which is what the console reports
          missing: ['pl'],
        },
      });
      expect(body.orphans.map((video) => video.id)).toEqual(['deleted0001']);
      expect(body.orphans[0]?.orphan).toBe(true);
      expect(body.counts).toEqual({ videos: 1, downloaded: 1, incomplete: 1, notDownloaded: 0, orphans: 1 });
    });

    it('reports the archive drift in both directions', async () => {
      const folderPath = await seedStateFolder('state-drift');
      // The first read builds the folder index, and a rebuild appends every
      // video it finds to archive.txt: the drift goes in after it
      await env.agent.get('/api/folder/state').query({ folderPath }).expect(200);
      await writeFile(path.join(folderPath, 'archive.txt'), 'youtube aaaaaaaaaaa\nyoutube gone0000001\n');

      const body = FolderStateResponseSchema.parse(
        (await env.agent.get('/api/folder/state').query({ folderPath })).body,
      );

      // `deleted0001` is on disk but not in the archive; `gone0000001` is the
      // other way round, a video whose files were deleted after a download.
      expect(body.drift.missingFromArchive).toEqual(['deleted0001']);
      expect(body.drift.missingFromDisk).toEqual(['gone0000001']);
    });

    it('filters the list without changing the counts', async () => {
      const folderPath = await seedStateFolder('state-filter');
      const read = async (filter: string) =>
        FolderStateResponseSchema.parse((await env.agent.get('/api/folder/state').query({ folderPath, filter })).body);

      const incomplete = await read('incomplete');
      expect(incomplete.videos.map((video) => video.id)).toEqual(['aaaaaaaaaaa']);
      expect(incomplete.orphans).toEqual([]);
      expect(incomplete.counts.orphans).toBe(1);

      const notDownloaded = await read('not-downloaded');
      expect(notDownloaded.videos).toEqual([]);

      const orphans = await read('orphan');
      expect(orphans.orphans.map((video) => video.id)).toEqual(['deleted0001']);
    });

    it('lists every orphan, sorted, whatever the filter', async () => {
      // The sort and the map only run once there is more than one orphan, and
      // an unsorted list is the kind of bug a screenshot does not catch. The
      // index mostly follows the file names, but it is built by a small pool,
      // so with two orphans it sometimes comes out sorted on its own. Five
      // whose titles sort against their ids leave that to chance no more.
      const folderPath = await env.seedFolder('state-orphans', {
        ...incompleteVideoFiles('aaaaaaaaaaa', 'Kept'),
        ...videoFiles('zzzzzzzzzzz', 'First'),
        ...videoFiles('eeeeeeeeeee', 'Second'),
        ...videoFiles('ddddddddddd', 'Third'),
        ...videoFiles('ccccccccccc', 'Upper'),
        ...videoFiles('bbbbbbbbbbb', 'Very last'),
      });
      env.setFolders('state-orphans');

      const body = FolderStateResponseSchema.parse(
        (await env.agent.get('/api/folder/state').query({ folderPath, filter: 'orphan' })).body,
      );

      expect(body.orphans.map((video) => video.id)).toEqual([
        'bbbbbbbbbbb',
        'ccccccccccc',
        'ddddddddddd',
        'eeeeeeeeeee',
        'zzzzzzzzzzz',
      ]);
      expect(body.orphans.map((video) => video.title)).toEqual(['Very last', 'Upper', 'Third', 'Second', 'First']);
      expect(body.counts.orphans).toBe(5);
    });

    it('refuses an unknown filter and an unknown folder', async () => {
      const folderPath = await seedStateFolder('state-refusals');

      expect((await env.agent.get('/api/folder/state').query({ folderPath, filter: 'nope' })).status).toBe(400);
      expect((await env.agent.get('/api/folder/state').query({ folderPath: '/etc' })).status).toBe(403);
    });

    it('answers one video state and says when the id is unknown', async () => {
      const folderPath = await seedStateFolder('state-one-video');
      const read = async (videoId: string) =>
        VideoStateResponseSchema.parse(
          (await env.agent.get('/api/folder/video-state').query({ folderPath, videoId })).body,
        );

      const known = await read('aaaaaaaaaaa');
      expect(known.known).toBe(true);
      expect(known.state.files?.video).toBe(true);

      const unknown = await read('zzzzzzzzzzz');
      expect(unknown.known).toBe(false);
      expect(unknown.state.files).toBeNull();
      expect(unknown.state.missing).toEqual([]);
    });

    it('rejects a videoId that is not a YouTube id', async () => {
      const folderPath = await seedStateFolder('state-bad-id');

      const response = await env.agent
        .get('/api/folder/video-state')
        .query({ folderPath, videoId: '../../etc/passwd' });

      expect(response.status).toBe(400);
    });

    it('asks for a videoId when the query carries none', async () => {
      const folderPath = await seedStateFolder('state-no-id');

      const response = await env.agent.get('/api/folder/video-state').query({ folderPath });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('videoId is required');
    });

    it('refuses a folder whose drive is away', async () => {
      // Configured and never created, which is what an unplugged volume looks
      // like. The mounted-folder guard answers with the unavailable code
      // instead of an empty state that reads like "nothing downloaded".
      env.setFolders('state-away');

      const response = await env.agent.get('/api/folder/state').query({ folderPath: env.folder('state-away') });

      expect(response.status).toBe(409);
      expect(response.body).toMatchObject({ code: FOLDER_UNAVAILABLE_CODE });
    });
  });

  describe('archive reconcile', () => {
    it('rewrites the archive from the disk and reports the diff', async () => {
      const folderPath = await env.seedFolder('reconcile-rebuild', videoFiles('aaaaaaaaaaa', 'Kept'));
      env.setFolders('reconcile-rebuild');
      // The index comes first: a rebuild appends every id it finds to
      // archive.txt, and would add the video before reconcile reads the file
      await env.agent.get('/api/folder/state').query({ folderPath }).expect(200);
      await writeFile(path.join(folderPath, 'archive.txt'), 'youtube ghost000001\n');

      const response = await env.agent.post('/api/folder/archive/reconcile').send({ folderPath, method: 'rebuild' });

      expect(response.status).toBe(200);
      const body = ArchiveReconcileResponseSchema.parse(response.body);
      expect(body.added).toEqual(['aaaaaaaaaaa']);
      expect(body.removed).toEqual(['ghost000001']);
      expect(body.drift).toEqual({ missingFromArchive: [], missingFromDisk: [] });
      expect(await archiveOf(folderPath)).toBe('youtube aaaaaaaaaaa\n');
    });

    it('rejects a videoIds list that is not an array of ids', async () => {
      const folderPath = await env.seedFolder('reconcile-bad-ids', {
        ...videoFiles('aaaaaaaaaaa', 'Kept'),
        'archive.txt': 'youtube ghost000001\n',
      });
      env.setFolders('reconcile-bad-ids');
      const remove = (videoIds: unknown) =>
        env.agent.post('/api/folder/archive/reconcile').send({ folderPath, method: 'remove', videoIds });

      expect((await remove('aaaaaaaaaaa')).status).toBe(400);
      expect((await remove(['../etc'])).status).toBe(400);
      // Refused before anything was written
      expect(await archiveOf(folderPath)).toBe('youtube ghost000001\n');
    });

    it('refuses a method it does not know', async () => {
      const folderPath = await env.seedFolder('reconcile-bad-method', {
        ...videoFiles('aaaaaaaaaaa', 'Kept'),
        'archive.txt': 'youtube ghost000001\n',
      });
      env.setFolders('reconcile-bad-method');

      const response = await env.agent
        .post('/api/folder/archive/reconcile')
        .send({ folderPath, method: 'delete-everything' });

      expect(response.status).toBe(400);
      expect(await archiveOf(folderPath)).toBe('youtube ghost000001\n');
    });

    it('refuses to rebuild while the drive looks unmounted', async () => {
      // No .info.json anywhere: emptying the archive here would send the next
      // run over the whole channel
      const folderPath = await env.seedFolder('reconcile-unmounted', {
        'archive.txt': 'youtube aaaaaaaaaaa\n',
        'config.json': folderConfig(),
      });
      env.setFolders('reconcile-unmounted');

      const response = await env.agent.post('/api/folder/archive/reconcile').send({ folderPath, method: 'rebuild' });

      expect(response.status).toBe(409);
      expect(String(response.body.error)).toMatch(/unmounted/);
      expect(await archiveOf(folderPath)).toBe('youtube aaaaaaaaaaa\n');
    });
  });
});
