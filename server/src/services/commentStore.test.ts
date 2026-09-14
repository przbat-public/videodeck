import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { invalidateCommentCache, loadCommentTree } from './commentStore';

describe('loadCommentTree', () => {
  let dir: string;
  let filePath: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'comment-store-'));
    filePath = path.join(dir, '20231201_Video.info.json');
    invalidateCommentCache();
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  const writeInfo = (comments: unknown) =>
    fs.writeFile(filePath, JSON.stringify({ comments }), 'utf-8');

  it('returns the parsed tree and reuses it while the file is unchanged', async () => {
    await writeInfo([{ id: 'c1', text: 'root', like_count: 3, replies: [] }]);
    const readFile = jest.spyOn(fs, 'readFile');

    const first = await loadCommentTree(dir, '20231201_Video');
    const second = await loadCommentTree(dir, '20231201_Video');

    expect(first?.[0]?.id).toBe('c1');
    expect(second).toBe(first);
    expect(readFile).toHaveBeenCalledTimes(1);
    readFile.mockRestore();
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
});
