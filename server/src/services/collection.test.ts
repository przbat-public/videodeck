import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readCollection } from './collection';
import { INDEX_FILE, rebuildIndex } from './folderIndex';

async function writeVideo(dir: string, baseName: string, info: { id: string; title: string }): Promise<void> {
  await fs.writeFile(path.join(dir, `${baseName}.info.json`), JSON.stringify(info), 'utf-8');
  await fs.writeFile(path.join(dir, `${baseName}.mp4`), 'video-bytes', 'utf-8');
}

describe('readCollection', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'collection-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('lists every downloaded video, newest upload first, all marked downloaded', async () => {
    await writeVideo(dir, '20130526_Home_built_SMD_Reflow_Oven', {
      id: 'Dube38fpLtc',
      title: 'Home built SMD Reflow Oven',
    });
    await writeVideo(dir, '20240101_Newer', { id: 'newer000001', title: 'Newer (v2)' });

    const { videos, downloadStatuses, lastUpdatedDates } = await readCollection(dir);

    expect(videos).toEqual([
      { id: 'newer000001', title: 'Newer (v2)', url: 'https://www.youtube.com/watch?v=newer000001' },
      { id: 'Dube38fpLtc', title: 'Home built SMD Reflow Oven', url: 'https://www.youtube.com/watch?v=Dube38fpLtc' },
    ]);
    expect(downloadStatuses).toEqual({ newer000001: true, Dube38fpLtc: true });
    expect(Object.keys(lastUpdatedDates).sort()).toEqual(['Dube38fpLtc', 'newer000001']);
  });

  it('includes videos downloaded outside the queue after the index was built', async () => {
    await writeVideo(dir, '20240101_Tracked', { id: 'tracked0001', title: 'Tracked' });
    await rebuildIndex(dir);
    await writeVideo(dir, '20200101_From_the_terminal', { id: 'terminal001', title: 'From the terminal' });

    const { videos } = await readCollection(dir);

    expect(videos.map((video) => video.id)).toEqual(['tracked0001', 'terminal001']);
  });

  it('makes a title from the file name for entries indexed before titles were recorded', async () => {
    const baseName = '20130526_Home_built_SMD_Reflow_Oven';
    await writeVideo(dir, baseName, { id: 'Dube38fpLtc', title: 'ignored' });
    const legacyIndex = {
      version: 1,
      builtAt: '2026-01-01T00:00:00.000Z',
      entries: { Dube38fpLtc: { baseName, videoFile: `${baseName}.mp4`, infoMtime: '2026-01-01T00:00:00.000Z' } },
    };
    await fs.writeFile(path.join(dir, INDEX_FILE), JSON.stringify(legacyIndex), 'utf-8');

    const { videos } = await readCollection(dir);

    expect(videos.map((video) => video.title)).toEqual(['Home built SMD Reflow Oven']);
  });
});
