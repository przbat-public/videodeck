import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { archiveDrift, folderLooksPresent, planArchive, readArchive, reconcileArchive } from './archive';
import type { FolderIndex } from './folderIndex';

/** An index holding the ids given, with the entry shape the index writes */
function indexOf(ids: readonly string[]): FolderIndex {
  const entries: FolderIndex['entries'] = {};
  for (const id of ids) {
    entries[id] = {
      baseName: `20240101_${id}`,
      videoFile: `20240101_${id}.mp4`,
      infoMtime: '2024-01-01T00:00:00.000Z',
      subtitleLangs: [],
      hasComments: false,
      hasDescription: false,
      hasThumbnail: false,
      videoBytes: 0,
      infoBytes: 0,
    };
  }
  return { version: 2, builtAt: '2024-01-01T00:00:00.000Z', entries };
}

describe('archive', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'archive-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  /** A folder that looks mounted: one info.json on disk */
  async function seedWithVideo(id = 'id-a'): Promise<void> {
    await fs.writeFile(path.join(dir, `20240101_${id}.info.json`), JSON.stringify({ id }), 'utf-8');
  }

  async function writeArchiveFile(ids: readonly string[]): Promise<void> {
    const content = ids.length > 0 ? `${ids.map((id) => `youtube ${id}`).join('\n')}\n` : '';
    await fs.writeFile(path.join(dir, 'archive.txt'), content, 'utf-8');
  }

  describe('archiveDrift', () => {
    it('names the ids each side is missing', () => {
      const drift = archiveDrift(indexOf(['id-a', 'id-b']), new Set(['id-a', 'id-ghost']));

      expect(drift.missingFromArchive).toEqual(['id-b']);
      expect(drift.missingFromDisk).toEqual(['id-ghost']);
    });

    it('reports nothing when the archive matches the disk', () => {
      expect(archiveDrift(indexOf(['id-a']), new Set(['id-a']))).toEqual({
        missingFromArchive: [],
        missingFromDisk: [],
      });
    });

    it('keeps both lists sorted, so two runs read the same', () => {
      const drift = archiveDrift(indexOf(['id-c', 'id-a', 'id-b']), new Set(['id-z', 'id-y']));

      expect(drift.missingFromArchive).toEqual(['id-a', 'id-b', 'id-c']);
      expect(drift.missingFromDisk).toEqual(['id-y', 'id-z']);
    });
  });

  describe('planArchive', () => {
    it('rebuild makes the archive the disk', () => {
      const plan = planArchive('rebuild', ['id-a', 'id-b'], new Set(['id-a', 'id-ghost']));

      expect(plan.added).toEqual(['id-b']);
      expect(plan.removed).toEqual(['id-ghost']);
      expect(plan.next).toEqual(['id-a', 'id-b']);
    });

    it('add records the ids named, and every id on disk when none are', () => {
      expect(planArchive('add', ['id-a', 'id-b'], new Set(), ['id-b']).next).toEqual(['id-b']);
      expect(planArchive('add', ['id-a', 'id-b'], new Set()).next).toEqual(['id-a', 'id-b']);
    });

    it('remove forgets the ids named and leaves the rest alone', () => {
      // "Download it again" has to work for a video the disk still holds, so
      // this is the one method that ignores the disk.
      const plan = planArchive('remove', ['id-a'], new Set(['id-a', 'id-b']), ['id-a']);

      expect(plan.removed).toEqual(['id-a']);
      expect(plan.next).toEqual(['id-b']);
    });

    it('remove without ids drops the lines the disk cannot back up', () => {
      const plan = planArchive('remove', ['id-a'], new Set(['id-a', 'id-ghost']));

      expect(plan.removed).toEqual(['id-ghost']);
      expect(plan.next).toEqual(['id-a']);
    });

    it('never adds an id twice', () => {
      const plan = planArchive('rebuild', ['id-a', 'id-a'], new Set(['id-a']));

      expect(plan.added).toEqual([]);
      expect(plan.next).toEqual(['id-a']);
    });
  });

  describe('reconcileArchive', () => {
    it('writes the disk state into the archive and reports the diff', async () => {
      await seedWithVideo('id-a');
      await writeArchiveFile(['id-ghost']);

      const result = await reconcileArchive(dir, 'rebuild', indexOf(['id-a']));

      expect(result.added).toEqual(['id-a']);
      expect(result.removed).toEqual(['id-ghost']);
      expect(await readArchive(dir)).toEqual(new Set(['id-a']));
      const raw = await fs.readFile(path.join(dir, 'archive.txt'), 'utf-8');
      expect(raw).toBe('youtube id-a\n');
    });

    it('removes one id so the next download fetches it again', async () => {
      await seedWithVideo('id-a');
      await writeArchiveFile(['id-a', 'id-b']);

      await reconcileArchive(dir, 'remove', indexOf(['id-a', 'id-b']), ['id-a']);

      expect(await readArchive(dir)).toEqual(new Set(['id-b']));
    });

    it('adds an id without touching the others', async () => {
      await seedWithVideo('id-a');
      await writeArchiveFile(['id-a']);

      const result = await reconcileArchive(dir, 'add', indexOf(['id-a', 'id-b']));

      expect(result.added).toEqual(['id-b']);
      expect(await readArchive(dir)).toEqual(new Set(['id-a', 'id-b']));
    });

    it('refuses to rebuild while the folder looks unmounted', async () => {
      // No .info.json anywhere: an absent drive. Emptying the archive here
      // would send the next run over the whole channel.
      await writeArchiveFile(['id-a', 'id-b']);

      await expect(reconcileArchive(dir, 'rebuild', indexOf([]))).rejects.toThrow(/looks unmounted/);
      expect(await readArchive(dir)).toEqual(new Set(['id-a', 'id-b']));
    });

    it('refuses the disk-following remove while the folder looks unmounted', async () => {
      await writeArchiveFile(['id-a']);

      await expect(reconcileArchive(dir, 'remove', indexOf([]))).rejects.toThrow(/looks unmounted/);
    });

    it('still forgets a named id while the folder looks unmounted', async () => {
      // Naming the id is the operator saying so, and that must work for a
      // video whose folder is on a drive that is away.
      await writeArchiveFile(['id-a', 'id-b']);

      const result = await reconcileArchive(dir, 'remove', indexOf([]), ['id-a']);

      expect(result.removed).toEqual(['id-a']);
      expect(await readArchive(dir)).toEqual(new Set(['id-b']));
    });

    it('leaves the file alone when there is nothing to change', async () => {
      await seedWithVideo('id-a');
      await writeArchiveFile(['id-a']);
      const archivePath = path.join(dir, 'archive.txt');
      const past = new Date('2024-01-01T00:00:00Z');
      await fs.utimes(archivePath, past, past);

      const result = await reconcileArchive(dir, 'rebuild', indexOf(['id-a']));

      expect(result).toEqual({ added: [], removed: [], unchanged: 1 });
      expect((await fs.stat(archivePath)).mtimeMs).toBe(past.getTime());
    });

    it('writes an empty archive when the disk holds nothing and the folder is there', async () => {
      // A folder with info.json files but no indexed videos: the line for a
      // deleted video is genuinely stale.
      await fs.writeFile(path.join(dir, '20240101_Gone.info.json'), '{"id":"id-gone"}', 'utf-8');
      await writeArchiveFile(['id-gone']);

      await reconcileArchive(dir, 'rebuild', indexOf([]));

      expect(await fs.readFile(path.join(dir, 'archive.txt'), 'utf-8')).toBe('');
    });
  });

  describe('folderLooksPresent', () => {
    it('answers false for a folder that holds no info.json', async () => {
      expect(await folderLooksPresent(dir)).toBe(false);
      await fs.writeFile(path.join(dir, 'config.json'), '{}', 'utf-8');
      expect(await folderLooksPresent(dir)).toBe(false);
    });

    it('answers true once a video is on disk', async () => {
      await seedWithVideo();
      expect(await folderLooksPresent(dir)).toBe(true);
    });
  });
});
