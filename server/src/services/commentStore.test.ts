import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import v8 from 'node:v8';
import {
  CACHE_HEAP_SHARE,
  invalidateCommentCache,
  loadCommentTree,
  TREE_HEAP_BYTES_PER_FILE_BYTE,
} from './commentStore';

describe('loadCommentTree', () => {
  let dir: string;
  let filePath: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'comment-store-'));
    filePath = path.join(dir, '20231201_Video.info.json');
    invalidateCommentCache();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(dir, { recursive: true, force: true });
  });

  const writeInfo = (comments: unknown) => fs.writeFile(filePath, JSON.stringify({ comments }), 'utf-8');

  /** `<stem>.info.json` with one comment of a fixed length, so every such file has the same size; returns that size */
  const writeVideo = async (stem: string): Promise<number> => {
    const file = path.join(dir, `${stem}.info.json`);
    await fs.writeFile(file, JSON.stringify({ comments: [{ id: stem, text: 'x'.repeat(1000) }] }), 'utf-8');
    return (await fs.stat(file)).size;
  };

  /** A heap limit whose cache budget holds this many trees of a file this size, by the weight the store gives them */
  const heapLimitFitting = (trees: number, fileBytes: number): void => {
    const real = v8.getHeapStatistics();
    vi.spyOn(v8, 'getHeapStatistics').mockReturnValue({
      ...real,
      heap_size_limit: (trees * fileBytes * TREE_HEAP_BYTES_PER_FILE_BYTE) / CACHE_HEAP_SHARE,
    });
  };

  it('returns the parsed tree and reuses it while the file is unchanged', async () => {
    await writeInfo([{ id: 'c1', text: 'root', like_count: 3, replies: [] }]);
    const readFile = vi.spyOn(fs, 'readFile');

    const first = await loadCommentTree(dir, '20231201_Video');
    const second = await loadCommentTree(dir, '20231201_Video');

    expect(first?.[0]?.id).toBe('c1');
    expect(second).toBe(first);
    expect(readFile).toHaveBeenCalledTimes(1);
  });

  it('re-reads once the file changes (new mtime) and on invalidation', async () => {
    await writeInfo([{ id: 'c1', text: 'one' }]);
    const first = await loadCommentTree(dir, '20231201_Video');

    await writeInfo([{ id: 'c2', text: 'two' }]);
    const changed = await loadCommentTree(dir, '20231201_Video');
    expect(changed?.[0]?.id).toBe('c2');
    expect(changed).not.toBe(first);

    invalidateCommentCache();
    const afterInvalidate = await loadCommentTree(dir, '20231201_Video');
    expect(afterInvalidate?.[0]?.id).toBe('c2');
    expect(afterInvalidate).not.toBe(changed);
  });

  it('returns null when the info.json is missing', async () => {
    await expect(loadCommentTree(dir, 'ghost')).resolves.toBeNull();
  });

  it('parses an info.json once for two requests that miss the cache together', async () => {
    // The details view and its first comments page land at the same moment,
    // and a comment-heavy file costs a parse of hundreds of megabytes each
    await writeInfo([{ id: 'c1', text: 'root' }]);
    const readFile = vi.spyOn(fs, 'readFile');

    const [first, second] = await Promise.all([
      loadCommentTree(dir, '20231201_Video'),
      loadCommentTree(dir, '20231201_Video'),
    ]);

    expect(readFile).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
  });

  it('never hands a rewritten file the parse of the version before it', async () => {
    await writeInfo([{ id: 'old', text: 'before the refresh' }]);
    const realReadFile = fs.readFile;
    const realStat = fs.stat;
    let oldContentRead!: () => void;
    const oldRead = new Promise<void>((resolve) => {
      oldContentRead = resolve;
    });
    let releaseOldParse!: () => void;
    const oldParseReleased = new Promise<void>((resolve) => {
      releaseOldParse = resolve;
    });
    // The first parse holds the old content until the second request is past its cache check
    vi.spyOn(fs, 'readFile').mockImplementationOnce(async (file, options) => {
      const content = await realReadFile(file, options);
      oldContentRead();
      await oldParseReleased;
      return content;
    });

    const first = loadCommentTree(dir, '20231201_Video');
    await oldRead;
    await writeInfo([{ id: 'new', text: 'after the refresh' }]);
    // A distinct mtime whatever the file system's clock granularity
    const later = new Date(Date.now() + 60_000);
    await fs.utimes(filePath, later, later);
    let newStatTaken!: () => void;
    const newStat = new Promise<void>((resolve) => {
      newStatTaken = resolve;
    });
    vi.spyOn(fs, 'stat').mockImplementationOnce(async (file, options) => {
      const stats = await realStat(file, options);
      newStatTaken();
      return stats;
    });
    const second = loadCommentTree(dir, '20231201_Video');
    await newStat;
    // One turn of the event loop: the second request finds no tree for the
    // new mtime and asks for a parse while the old one is still running
    await new Promise((resolve) => setImmediate(resolve));
    releaseOldParse();

    expect((await first)?.[0]?.id).toBe('old');
    expect((await second)?.[0]?.id).toBe('new');
  });

  it('answers no comments for an info.json past the string limit, without reading it', async () => {
    // Past V8's longest string (536,870,888 code units on Node 24) readFile
    // fails the way it does here, and every comments page answered 500
    await writeInfo([{ id: 'c1', text: 'root' }]);
    const realStat = fs.stat;
    vi.spyOn(fs, 'stat').mockImplementation(async (file) =>
      Object.assign(await realStat(file), { size: 600 * 1024 * 1024 }),
    );
    const readFile = vi.spyOn(fs, 'readFile').mockRejectedValue(new RangeError('Invalid string length'));

    await expect(loadCommentTree(dir, '20231201_Video')).resolves.toEqual([]);
    expect(readFile).not.toHaveBeenCalled();
  });

  it('reads a broken info.json again on the next request', async () => {
    await fs.writeFile(filePath, '{"comments": [', 'utf-8');
    const readFile = vi.spyOn(fs, 'readFile');

    await expect(loadCommentTree(dir, '20231201_Video')).rejects.toThrow(SyntaxError);
    await expect(loadCommentTree(dir, '20231201_Video')).rejects.toThrow(SyntaxError);

    expect(readFile).toHaveBeenCalledTimes(2);
  });

  it('drops the least recently read tree once the trees pass a quarter of the heap limit', async () => {
    const size = await writeVideo('a');
    await writeVideo('b');
    await writeVideo('c');
    heapLimitFitting(2.5, size);
    await loadCommentTree(dir, 'a');
    await loadCommentTree(dir, 'b');
    // Read again, so b is now the tree read longest ago
    await loadCommentTree(dir, 'a');
    // Three trees pass the budget of two and a half
    await loadCommentTree(dir, 'c');
    const readFile = vi.spyOn(fs, 'readFile');

    await loadCommentTree(dir, 'a');
    await loadCommentTree(dir, 'c');
    expect(readFile).not.toHaveBeenCalled();

    await loadCommentTree(dir, 'b');
    expect(readFile).toHaveBeenCalledTimes(1);
  });

  it('keeps the newest tree even when it alone passes the budget', async () => {
    const size = await writeVideo('a');
    await writeVideo('b');
    heapLimitFitting(0.5, size);
    await loadCommentTree(dir, 'a');
    await loadCommentTree(dir, 'b');
    const readFile = vi.spyOn(fs, 'readFile');

    await loadCommentTree(dir, 'b');
    expect(readFile).not.toHaveBeenCalled();

    await loadCommentTree(dir, 'a');
    expect(readFile).toHaveBeenCalledTimes(1);
  });

  it('weighs a tree by the file it parsed when a refresh swaps that file in after the stat', async () => {
    // An update or a comment repair renames a new info.json over the live one,
    // and the rename can land between the stat and the read: a small file
    // grown to hundreds of megabytes was then booked at its old size
    const size = await writeVideo('a');
    await writeVideo('b');
    await writeVideo('c');
    heapLimitFitting(2.5, size);
    await loadCommentTree(dir, 'b');
    await loadCommentTree(dir, 'c');
    const realStat = fs.stat;
    vi.spyOn(fs, 'stat').mockImplementationOnce(async (file, options) => {
      const stats = await realStat(file, options);
      const comments = [{ id: 'a', text: 'x'.repeat(10 * size) }];
      await fs.writeFile(path.join(dir, 'a.info.json'), JSON.stringify({ comments }), 'utf-8');
      return stats;
    });
    const swapped = await loadCommentTree(dir, 'a');
    expect(swapped?.[0]?.text).toHaveLength(10 * size);
    const readFile = vi.spyOn(fs, 'readFile');

    // The large tree alone passes the budget of two and a half small ones, so
    // neither small tree stays beside it. Booked at the stat's size, a would
    // have pushed out only b, the tree read longest ago
    await loadCommentTree(dir, 'c');
    expect(readFile).toHaveBeenCalledTimes(1);
    await loadCommentTree(dir, 'b');
    expect(readFile).toHaveBeenCalledTimes(2);
  });

  it('counts nothing against the budget once the cache is invalidated', async () => {
    const size = await writeVideo('a');
    await writeVideo('b');
    heapLimitFitting(2.5, size);
    await loadCommentTree(dir, 'a');
    await loadCommentTree(dir, 'b');
    invalidateCommentCache();

    await loadCommentTree(dir, 'a');
    await loadCommentTree(dir, 'b');
    const readFile = vi.spyOn(fs, 'readFile');
    await loadCommentTree(dir, 'a');
    await loadCommentTree(dir, 'b');

    expect(readFile).not.toHaveBeenCalled();
  });
});
