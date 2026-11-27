import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  commitStagedRefresh,
  mergeInfoJson,
  removeStaging,
  STAGING_DIR,
  stagedCommentsInterrupted,
  stagingPathFor,
  sweepStagingDirs,
  usesStaging,
} from './refreshStaging';

const STEM = '20260101_A_video';

describe('usesStaging', () => {
  it('stages the jobs that rewrite an existing stem with what YouTube returns today', () => {
    expect(usesStaging({ type: 'update' })).toBe(true);
    expect(usesStaging({ type: 'repair', writeComments: true })).toBe(true);
  });

  it('leaves downloads and sidecar repairs writing in place', () => {
    // A download writes a stem that is not there yet, and a sidecar repair
    // already keeps every file it finds (--no-overwrites)
    expect(usesStaging({ type: 'download' })).toBe(false);
    expect(usesStaging({ type: 'repair' })).toBe(false);
    expect(usesStaging({ type: 'repair', writeComments: false })).toBe(false);
  });
});

describe('mergeInfoJson', () => {
  const comment = (id: string, extra: Record<string, unknown> = {}) => ({ id, text: `text ${id}`, ...extra });

  it('keeps the archived comments YouTube no longer returns, after the fresh ones', () => {
    const old = { id: 'v', comments: [comment('a'), comment('gone-upstream')] };
    const fresh = { id: 'v', comments: [comment('a', { like_count: 9 }), comment('new')] };

    const { merged } = mergeInfoJson(old, fresh);

    expect((merged.comments as { id: string }[]).map((c) => c.id)).toEqual(['a', 'new', 'gone-upstream']);
    // The fresh copy of a comment wins: its like count moved
    expect((merged.comments as { like_count?: number }[])[0]?.like_count).toBe(9);
  });

  it("keeps a comment's archived publish time, which a later fetch can only estimate worse", () => {
    // yt-dlp turns YouTube's relative "3 days ago" into a timestamp at fetch
    // time, so a refresh two years on would rewrite it to "today minus 2 years"
    const old = { id: 'v', comments: [comment('a', { timestamp: 1_700_000_000, _time_text: '3 days ago' })] };
    const fresh = { id: 'v', comments: [comment('a', { timestamp: 1_760_000_000, _time_text: '2 years ago' })] };

    const merged = mergeInfoJson(old, fresh).merged.comments as { timestamp: number; _time_text: string }[];

    expect(merged[0]).toMatchObject({ timestamp: 1_700_000_000, _time_text: '3 days ago' });
  });

  it('keeps the whole archived comment section when the fresh run has none', () => {
    // Comments turned off upstream since the download: yt-dlp writes no
    // comments key at all
    const old = { id: 'v', comment_count: 2, comments: [comment('a'), comment('b')] };

    const { merged, notes } = mergeInfoJson(old, { id: 'v', title: 'Fresh title' });

    expect(merged.comments).toEqual(old.comments);
    expect(merged.comment_count).toBe(2);
    expect(merged.title).toBe('Fresh title');
    expect(notes.join(' ')).toMatch(/kept 2 archived comments/);
  });

  it('keeps a field the fresh run did not get, instead of deleting it', () => {
    // yt-dlp never writes a null: a missing key means "not fetched", and the
    // watch-page data behind like_count and chapters is fetched non-fatally
    const old = { id: 'v', like_count: 120, chapters: [{ title: 'Intro' }], view_count: 1 };

    const { merged } = mergeInfoJson(old, { id: 'v', view_count: 5 });

    expect(merged).toMatchObject({ like_count: 120, chapters: [{ title: 'Intro' }], view_count: 5 });
  });

  it('never replaces an archived description with a blank or missing one', () => {
    const old = { id: 'v', description: 'Archived description.' };

    expect(mergeInfoJson(old, { id: 'v', description: '  \n' }).merged.description).toBe('Archived description.');
    expect(mergeInfoJson(old, { id: 'v' }).merged.description).toBe('Archived description.');
    expect(mergeInfoJson(old, { id: 'v', description: 'Fresh.' }).merged.description).toBe('Fresh.');
  });

  it('keeps the fresh key order, so the id and the title stay in the head the index reads', () => {
    const { merged } = mergeInfoJson({ like_count: 1, id: 'v' }, { id: 'v', title: 't' });

    expect(Object.keys(merged).slice(0, 2)).toEqual(['id', 'title']);
  });
});

describe('commitStagedRefresh', () => {
  let dir: string;
  const JOB = 'job-1';
  const staged = (name: string) => path.join(dir, stagingPathFor(JOB), name);
  const live = (name: string) => path.join(dir, name);
  const commit = (extra: Partial<Parameters<typeof commitStagedRefresh>[0]> = {}) =>
    commitStagedRefresh({ folderPath: dir, jobId: JOB, stem: STEM, videoId: 'v', ...extra });
  const runningAsRoot = process.getuid?.() === 0;

  async function stage(files: Record<string, string>): Promise<void> {
    await fs.mkdir(path.join(dir, stagingPathFor(JOB)), { recursive: true });
    for (const [name, body] of Object.entries(files)) {
      await fs.writeFile(staged(name), body, 'utf-8');
    }
  }

  async function seedLive(files: Record<string, string>): Promise<void> {
    for (const [name, body] of Object.entries(files)) {
      await fs.writeFile(live(name), body, 'utf-8');
    }
  }

  const anHourAgo = () => new Date(Date.now() - 60 * 60 * 1000);

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'refresh-staging-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('merges the info.json, replaces a changed subtitle and leaves an identical one alone', async () => {
    await seedLive({
      [`${STEM}.info.json`]: JSON.stringify({ id: 'v', comments: [{ id: 'old' }] }),
      [`${STEM}.en.vtt`]: 'WEBVTT\n\nsame\n',
      [`${STEM}.pl.vtt`]: 'WEBVTT\n\nold polish\n',
    });
    const past = anHourAgo();
    await fs.utimes(live(`${STEM}.en.vtt`), past, past);
    const enMtime = (await fs.stat(live(`${STEM}.en.vtt`))).mtimeMs;
    await stage({
      [`${STEM}.info.json`]: JSON.stringify({ id: 'v', comments: [{ id: 'new' }] }),
      [`${STEM}.en.vtt`]: 'WEBVTT\n\nsame\n',
      [`${STEM}.pl.vtt`]: 'WEBVTT\n\nnew polish\n',
    });
    // yt-dlp wrote the staged file long before the commit's turn came
    await fs.utimes(staged(`${STEM}.pl.vtt`), past, past);

    await commit();

    const info = JSON.parse(await fs.readFile(live(`${STEM}.info.json`), 'utf-8'));
    expect(info.comments.map((c: { id: string }) => c.id)).toEqual(['new', 'old']);
    expect(await fs.readFile(live(`${STEM}.pl.vtt`), 'utf-8')).toBe('WEBVTT\n\nnew polish\n');
    // An identical subtitle keeps its mtime, so a summary made from it stays
    // valid; a changed one gets the commit time, so a summary made from the
    // old text while the job waited cannot pass for current
    expect((await fs.stat(live(`${STEM}.en.vtt`))).mtimeMs).toBe(enMtime);
    expect((await fs.stat(live(`${STEM}.pl.vtt`))).mtimeMs).toBeGreaterThan(past.getTime() + 30 * 60 * 1000);
  });

  it('keeps a subtitle the run did not fetch again', async () => {
    await seedLive({ [`${STEM}.info.json`]: '{"id":"v"}', [`${STEM}.en.vtt`]: 'WEBVTT\n\narchived\n' });
    await stage({ [`${STEM}.info.json`]: '{"id":"v"}' });

    await commit();

    expect(await fs.readFile(live(`${STEM}.en.vtt`), 'utf-8')).toBe('WEBVTT\n\narchived\n');
  });

  it('keeps an archived human subtitle that YouTube now offers only as machine captions', async () => {
    // Once the manual track is gone upstream, yt-dlp writes the automatic one
    // under the same name
    await seedLive({
      [`${STEM}.info.json`]: JSON.stringify({ id: 'v', subtitles: { en: [{ ext: 'vtt', name: 'English' }] } }),
      [`${STEM}.en.vtt`]: 'WEBVTT\n\nwritten by a person\n',
    });
    await stage({
      [`${STEM}.info.json`]: JSON.stringify({ id: 'v', subtitles: {}, automatic_captions: { en: [{ ext: 'vtt' }] } }),
      [`${STEM}.en.vtt`]: 'WEBVTT\n\nmachine captions\n',
    });

    const report = await commit();

    expect(await fs.readFile(live(`${STEM}.en.vtt`), 'utf-8')).toBe('WEBVTT\n\nwritten by a person\n');
    const info = JSON.parse(await fs.readFile(live(`${STEM}.info.json`), 'utf-8'));
    expect(info.subtitles).toEqual({ en: [{ ext: 'vtt', name: 'English' }] });
    expect(report.notes.join(' ')).toMatch(/kept the archived en subtitle/);
  });

  it('keeps an archived human subtitle when the folder turned human tracks off', async () => {
    // --no-write-subs: yt-dlp writes machine captions under the human track's
    // name, while YouTube still lists the human track
    await seedLive({
      [`${STEM}.info.json`]: JSON.stringify({ id: 'v', subtitles: { en: [{ ext: 'vtt' }] } }),
      [`${STEM}.en.vtt`]: 'WEBVTT\n\nwritten by a person\n',
    });
    await stage({
      [`${STEM}.info.json`]: JSON.stringify({
        id: 'v',
        subtitles: { en: [{ ext: 'vtt' }] },
        automatic_captions: { en: [] },
      }),
      [`${STEM}.en.vtt`]: 'WEBVTT\n\nmachine captions\n',
    });

    await commit({ requestsHumanSubtitles: false });

    expect(await fs.readFile(live(`${STEM}.en.vtt`), 'utf-8')).toBe('WEBVTT\n\nwritten by a person\n');
  });

  it('remembers a human track across a refresh that brought no file for it', async () => {
    // Run 1: the human track is gone upstream and the machine one was
    // throttled, so nothing is staged for en. Run 2 brings machine captions.
    await seedLive({
      [`${STEM}.info.json`]: JSON.stringify({ id: 'v', subtitles: { en: [{ ext: 'vtt' }] } }),
      [`${STEM}.en.vtt`]: 'WEBVTT\n\nwritten by a person\n',
    });
    await stage({ [`${STEM}.info.json`]: JSON.stringify({ id: 'v', subtitles: {} }) });
    await commit();
    await stage({
      [`${STEM}.info.json`]: JSON.stringify({ id: 'v', subtitles: {}, automatic_captions: { en: [] } }),
      [`${STEM}.en.vtt`]: 'WEBVTT\n\nmachine captions\n',
    });

    await commit();

    expect(await fs.readFile(live(`${STEM}.en.vtt`), 'utf-8')).toBe('WEBVTT\n\nwritten by a person\n');
  });

  it('replaces archived machine captions even without a fresh info.json', async () => {
    // Nothing human to lose: the archive lists en only as automatic
    await seedLive({
      [`${STEM}.info.json`]: JSON.stringify({ id: 'v', subtitles: {}, automatic_captions: { en: [] } }),
      [`${STEM}.en.vtt`]: 'WEBVTT\n\nold machine captions\n',
    });
    await stage({ [`${STEM}.en.vtt`]: 'WEBVTT\n\nbetter machine captions\n' });

    await commit();

    expect(await fs.readFile(live(`${STEM}.en.vtt`), 'utf-8')).toBe('WEBVTT\n\nbetter machine captions\n');
  });

  it('keeps a subtitle whose source it cannot tell, and records it for the next refresh', async () => {
    // No archived info.json to say whether en was written by a person: it
    // stays, and the info.json taken as it is remembers that, so a later
    // refresh does not replace it with machine captions either
    await seedLive({ [`${STEM}.en.vtt`]: 'WEBVTT\n\nunknown source\n' });
    await stage({
      [`${STEM}.info.json`]: JSON.stringify({ id: 'v', subtitles: {} }),
      [`${STEM}.en.vtt`]: 'WEBVTT\n\nmachine captions\n',
    });

    const report = await commit();

    expect(await fs.readFile(live(`${STEM}.en.vtt`), 'utf-8')).toBe('WEBVTT\n\nunknown source\n');
    expect(report.notes.join(' ')).toMatch(/kept the archived en subtitle/);

    await stage({
      [`${STEM}.info.json`]: JSON.stringify({ id: 'v', subtitles: {}, automatic_captions: { en: [] } }),
      [`${STEM}.en.vtt`]: 'WEBVTT\n\nmachine captions\n',
    });
    await commit();
    expect(await fs.readFile(live(`${STEM}.en.vtt`), 'utf-8')).toBe('WEBVTT\n\nunknown source\n');
  });

  it('keeps a subtitle while the archived info.json is too large to read', async () => {
    await seedLive({
      [`${STEM}.info.json`]: JSON.stringify({ id: 'v', comments: ['x'.repeat(200)] }),
      [`${STEM}.en.vtt`]: 'WEBVTT\n\narchived\n',
    });
    await stage({ [`${STEM}.en.vtt`]: 'WEBVTT\n\nfresh\n' });

    const report = await commit({ maxInfoBytes: 100 });

    expect(await fs.readFile(live(`${STEM}.en.vtt`), 'utf-8')).toBe('WEBVTT\n\narchived\n');
    expect(report.notes.join(' ')).toMatch(/kept the archived en subtitle/);
  });

  it('keeps the archived thumbnail and fills only a missing one', async () => {
    // A 429 on the best candidates makes yt-dlp fall back to a worse image
    // under the same name, and a cut transfer leaves a truncated file
    await seedLive({ [`${STEM}.webp`]: 'archived-high-res' });
    await stage({ [`${STEM}.webp`]: 'fallback' });

    await commit();
    expect(await fs.readFile(live(`${STEM}.webp`), 'utf-8')).toBe('archived-high-res');

    await fs.rm(live(`${STEM}.webp`));
    await stage({ [`${STEM}.jpg`]: 'fresh-jpg' });
    await commit();
    expect(await fs.readFile(live(`${STEM}.jpg`), 'utf-8')).toBe('fresh-jpg');
  });

  it('adds a live chat replay the archive lacks and keeps the one it has', async () => {
    await stage({ [`${STEM}.live_chat.json`]: '{"replay":1}' });
    await commit();
    expect(await fs.readFile(live(`${STEM}.live_chat.json`), 'utf-8')).toBe('{"replay":1}');

    await stage({ [`${STEM}.live_chat.json`]: '{"replay":2}' });
    const report = await commit();
    expect(await fs.readFile(live(`${STEM}.live_chat.json`), 'utf-8')).toBe('{"replay":1}');
    expect(report.notes.join(' ')).not.toMatch(/dropped/);
  });

  it('never replaces the description file with a blank one', async () => {
    await seedLive({ [`${STEM}.description`]: 'Archived description.' });
    await stage({ [`${STEM}.description`]: '' });

    await commit();

    expect(await fs.readFile(live(`${STEM}.description`), 'utf-8')).toBe('Archived description.');
  });

  it('drops leftovers yt-dlp did not finish and names them', async () => {
    await stage({ [`${STEM}.pl.vtt.part`]: 'half a subtitle', [`${STEM}.unexpected.bin`]: 'x' });

    const report = await commit();

    await expect(fs.access(live(`${STEM}.pl.vtt.part`))).rejects.toThrow();
    await expect(fs.access(live(`${STEM}.unexpected.bin`))).rejects.toThrow();
    expect(report.notes.join(' ')).toMatch(/dropped .*\.part/);
  });

  it('stops when the files under this name belong to another video, and keeps every file', async () => {
    // Two videos with one upload date and one title share a file name; a
    // merge would write a video that never existed
    const archived = { [`${STEM}.info.json`]: '{"id":"other","comments":[{"id":"b"}]}', [`${STEM}.en.vtt`]: 'other' };
    await seedLive(archived);
    await stage({ [`${STEM}.info.json`]: '{"id":"v","comments":[{"id":"a"}]}', [`${STEM}.en.vtt`]: 'mine' });

    await expect(commit()).rejects.toThrow(/belongs to other, not v/);

    for (const [name, body] of Object.entries(archived)) {
      expect(await fs.readFile(live(name), 'utf-8')).toBe(body);
    }
    await expect(fs.access(path.join(dir, stagingPathFor(JOB)))).rejects.toThrow();
  });

  it('keeps a live info.json that is not a regular file, and still commits the other files', async () => {
    await fs.mkdir(live(`${STEM}.info.json`));
    await stage({ [`${STEM}.info.json`]: '{"id":"v"}', [`${STEM}.en.vtt`]: 'WEBVTT\n\nfresh\n' });

    const report = await commit();

    expect((await fs.stat(live(`${STEM}.info.json`))).isDirectory()).toBe(true);
    expect(await fs.readFile(live(`${STEM}.en.vtt`), 'utf-8')).toBe('WEBVTT\n\nfresh\n');
    expect(report.notes.join(' ')).toMatch(/kept the archived info\.json/);
  });

  it.skipIf(runningAsRoot)('keeps a live info.json it is not allowed to read', async () => {
    // Only a missing file counts as absent: a read that fails for any other
    // reason must not let today's file replace the archive
    await seedLive({ [`${STEM}.info.json`]: '{"id":"v","comments":[{"id":"archived"}]}' });
    await fs.chmod(live(`${STEM}.info.json`), 0o000);
    await stage({ [`${STEM}.info.json`]: '{"id":"v"}' });

    try {
      const report = await commit();
      expect(report.notes.join(' ')).toMatch(/kept the archived info\.json: .*EACCES/);
    } finally {
      await fs.chmod(live(`${STEM}.info.json`), 0o644);
    }
    expect(await fs.readFile(live(`${STEM}.info.json`), 'utf-8')).toBe('{"id":"v","comments":[{"id":"archived"}]}');
  });

  it('keeps a live info.json whose stat fails', async () => {
    // A link to itself: stat answers ELOOP, which is no "missing file" either
    await fs.symlink(live(`${STEM}.info.json`), live(`${STEM}.info.json`));
    await stage({ [`${STEM}.info.json`]: '{"id":"v"}' });

    const report = await commit();

    expect((await fs.lstat(live(`${STEM}.info.json`))).isSymbolicLink()).toBe(true);
    expect(report.notes.join(' ')).toMatch(/kept the archived info\.json: .*ELOOP/);
  });

  it('moves an archived info.json that does not parse aside and takes the fresh one', async () => {
    // Nothing else can repair it: a sidecar repair keeps it, the scanner skips it
    await seedLive({ [`${STEM}.info.json`]: '{"id":"v", truncated' });
    await stage({ [`${STEM}.info.json`]: '{"id":"v","title":"t"}' });

    const report = await commit();

    expect(JSON.parse(await fs.readFile(live(`${STEM}.info.json`), 'utf-8'))).toEqual({ id: 'v', title: 't' });
    const aside = (await fs.readdir(dir)).filter((name) => name.startsWith(`${STEM}.info.json.unparseable-`));
    expect(aside).toHaveLength(1);
    expect(await fs.readFile(live(aside[0] ?? ''), 'utf-8')).toBe('{"id":"v", truncated');
    expect(report.notes.join(' ')).toMatch(/did not parse: copied it aside/);
  });

  it('stops when an archived info.json that does not parse names another video', async () => {
    // A truncated file still names its video at its head
    await seedLive({ [`${STEM}.info.json`]: '{"id": "other", "title": "B", cut' });
    await stage({ [`${STEM}.info.json`]: '{"id":"v"}', [`${STEM}.description`]: 'Mine.' });

    await expect(commit()).rejects.toThrow(/belongs to other/);
    expect(await fs.readFile(live(`${STEM}.info.json`), 'utf-8')).toBe('{"id": "other", "title": "B", cut');
  });

  it('takes a fresh info.json too large to merge when the archive has none', async () => {
    // The cap protects a merge; with no archive nothing is merged
    await stage({ [`${STEM}.info.json`]: JSON.stringify({ id: 'v', comments: ['x'.repeat(200)] }) });

    const report = await commit({ maxInfoBytes: 100 });

    expect(report.committed).toEqual([`${STEM}.info.json`]);
  });

  it('keeps an info.json too large to merge safely', async () => {
    const archived = JSON.stringify({ id: 'v', comments: [{ id: 'a', text: 'x'.repeat(200) }] });
    await seedLive({ [`${STEM}.info.json`]: archived });
    await stage({ [`${STEM}.info.json`]: '{"id":"v"}' });

    const report = await commit({ maxInfoBytes: 100 });

    expect(await fs.readFile(live(`${STEM}.info.json`), 'utf-8')).toBe(archived);
    expect(report.notes.join(' ')).toMatch(/too large to merge/);
  });

  it('checks the id at the head of an info.json too large to merge', async () => {
    await seedLive({ [`${STEM}.info.json`]: JSON.stringify({ id: 'other', comments: ['x'.repeat(200)] }) });
    await stage({ [`${STEM}.description`]: 'Mine.' });

    await expect(commit({ maxInfoBytes: 100 })).rejects.toThrow(/belongs to other/);
  });

  it('takes the fresh info.json as it is when the archive has none', async () => {
    await stage({ [`${STEM}.info.json`]: '{"id":"v","title":"t"}' });

    await commit();

    expect(JSON.parse(await fs.readFile(live(`${STEM}.info.json`), 'utf-8'))).toEqual({ id: 'v', title: 't' });
  });

  it('removes the staging directory once the files are in place', async () => {
    await stage({ [`${STEM}.info.json`]: '{"id":"v"}' });

    await commit();

    await expect(fs.access(path.join(dir, stagingPathFor(JOB)))).rejects.toThrow();
  });

  it('treats a missing staging directory as nothing staged', async () => {
    // yt-dlp creates nothing for a run its filters skip
    await seedLive({ [`${STEM}.info.json`]: '{"id":"v"}' });

    const report = await commit();

    expect(report.committed).toEqual([]);
    expect(await fs.readFile(live(`${STEM}.info.json`), 'utf-8')).toBe('{"id":"v"}');
  });

  it('refuses a staging directory that is a link, and removes nothing through it', async () => {
    const elsewhere = await fs.mkdtemp(path.join(os.tmpdir(), 'refresh-staging-target-'));
    try {
      await fs.mkdir(path.join(elsewhere, JOB));
      await fs.writeFile(path.join(elsewhere, 'precious.txt'), 'keep me', 'utf-8');
      await fs.symlink(elsewhere, path.join(dir, STAGING_DIR));

      await expect(commit()).rejects.toThrow(/not a plain directory/);
      await removeStaging(dir, JOB, new Set());

      expect((await fs.readdir(elsewhere)).sort()).toEqual([JOB, 'precious.txt']);
    } finally {
      await fs.rm(elsewhere, { recursive: true, force: true });
    }
  });

  it('runs one commit at a time, across folders', async () => {
    // Parsing a comment-heavy info.json holds the heap and blocks the event
    // loop; two folders' hook chains must not do it at once
    const other = await fs.mkdtemp(path.join(os.tmpdir(), 'refresh-staging-other-'));
    try {
      await stage({ [`${STEM}.description`]: 'First.' });
      await fs.mkdir(path.join(other, stagingPathFor(JOB)), { recursive: true });
      await fs.writeFile(path.join(other, stagingPathFor(JOB), `${STEM}.description`), 'Second.', 'utf-8');
      let release: () => void = () => undefined;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const realReaddir = fs.readdir.bind(fs);
      const readdir = vi.spyOn(fs, 'readdir').mockImplementation((async (target: string) => {
        if (target.startsWith(dir)) {
          await held;
        }
        return realReaddir(target);
      }) as unknown as typeof fs.readdir);

      try {
        const first = commit();
        const second = commitStagedRefresh({ folderPath: other, jobId: JOB, stem: STEM, videoId: 'v' });
        // The first commit is held at its readdir; give the second every
        // chance to start meanwhile
        await vi.waitFor(() =>
          expect(readdir.mock.calls.some(([target]) => String(target).startsWith(dir))).toBe(true),
        );
        for (let turn = 0; turn < 3; turn += 1) {
          await new Promise((resolve) => setImmediate(resolve));
        }
        expect(readdir.mock.calls.some(([target]) => String(target).startsWith(other))).toBe(false);

        release();
        await Promise.all([first, second]);
        expect(await fs.readFile(path.join(other, `${STEM}.description`), 'utf-8')).toBe('Second.');
      } finally {
        release();
        readdir.mockRestore();
      }
    } finally {
      await fs.rm(other, { recursive: true, force: true });
    }
  });
});

describe('staging housekeeping', () => {
  let dir: string;
  const runningAsRoot = process.getuid?.() === 0;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'refresh-staging-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('removes a job directory and the leftovers of jobs this process no longer runs', async () => {
    for (const id of ['done-job', 'running-job', 'stale-job']) {
      await fs.mkdir(path.join(dir, stagingPathFor(id)), { recursive: true });
    }

    await removeStaging(dir, 'done-job', new Set(['running-job']));

    const left = await fs.readdir(path.join(dir, STAGING_DIR));
    expect(left).toEqual(['running-job']);
  });

  it('sweeps every staging directory at boot, before any job runs', async () => {
    await fs.mkdir(path.join(dir, stagingPathFor('from-last-run')), { recursive: true });
    await fs.writeFile(path.join(dir, `${STEM}.info.json`), '{"id":"v"}', 'utf-8');

    await sweepStagingDirs([dir, path.join(dir, 'missing-folder')]);

    await expect(fs.access(path.join(dir, STAGING_DIR))).rejects.toThrow();
    expect(await fs.readFile(path.join(dir, `${STEM}.info.json`), 'utf-8')).toBe('{"id":"v"}');
  });

  it.skipIf(runningAsRoot)('still boots when one leftover cannot be removed', async () => {
    // A drive remounted read-only, a directory another user owns: the sweep
    // logs it and moves on instead of failing the boot
    const stuck = path.join(dir, 'stuck');
    const fine = path.join(dir, 'fine');
    await fs.mkdir(path.join(stuck, stagingPathFor('old-job')), { recursive: true });
    await fs.mkdir(path.join(fine, stagingPathFor('old-job')), { recursive: true });
    await fs.chmod(path.join(stuck, STAGING_DIR), 0o555);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await expect(sweepStagingDirs([stuck, fine])).resolves.toBeUndefined();
      await expect(fs.access(path.join(fine, STAGING_DIR))).rejects.toThrow();
    } finally {
      await fs.chmod(path.join(stuck, STAGING_DIR), 0o755);
      vi.restoreAllMocks();
    }
  });

  it('recognises a comment extraction yt-dlp cut short', async () => {
    // Under -i a refused comment page ends in exit 1, yet the info.json is
    // written with the comments that did arrive and without comment_count
    await fs.mkdir(path.join(dir, stagingPathFor('job')), { recursive: true });
    const info = path.join(dir, stagingPathFor('job'), `${STEM}.info.json`);

    await fs.writeFile(info, JSON.stringify({ id: 'v', comments: [{ id: 'a' }] }), 'utf-8');
    expect(await stagedCommentsInterrupted(dir, 'job', STEM)).toBe(true);

    await fs.writeFile(info, JSON.stringify({ id: 'v', comment_count: 1, comments: [{ id: 'a' }] }), 'utf-8');
    expect(await stagedCommentsInterrupted(dir, 'job', STEM)).toBe(false);

    await fs.rm(info);
    expect(await stagedCommentsInterrupted(dir, 'job', STEM)).toBe(false);
  });
});
