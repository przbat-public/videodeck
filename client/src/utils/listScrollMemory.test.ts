import { describe, expect, it } from 'vitest';
import { clearListPositions, readListPosition, writeListPosition } from './listScrollMemory';

describe('listScrollMemory', () => {
  it('remembers a position under its own search URL', () => {
    clearListPositions();

    writeListPosition('/?q=drone', { loadedCount: 200, scrollY: 1200 });

    expect(readListPosition('/?q=drone')).toEqual({ loadedCount: 200, scrollY: 1200 });
    expect(readListPosition('/?q=kosmos')).toBeUndefined();
  });

  it('keeps the newest position for a URL', () => {
    clearListPositions();
    writeListPosition('/', { loadedCount: 100, scrollY: 10 });

    writeListPosition('/', { loadedCount: 300, scrollY: 4200 });

    expect(readListPosition('/')).toEqual({ loadedCount: 300, scrollY: 4200 });
  });

  it('forgets everything on clear', () => {
    writeListPosition('/', { loadedCount: 100, scrollY: 10 });

    clearListPositions();

    expect(readListPosition('/')).toBeUndefined();
  });
});
