import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  availabilitySkipReason,
  clearUnavailable,
  readUnavailable,
  recordUnavailable,
  UNAVAILABLE_FILE,
  UNAVAILABLE_TTL_MS,
  unavailableSkipReason,
} from './unavailableVideos';

/** Two ids with the shape YouTube uses, so the record accepts them */
const MEMBERS_ONLY = 'dQw4w9WgXcQ';
const PREMIUM_ONLY = '9bZkp7q19f0';
const NOW = Date.parse('2026-10-04T12:00:00.000Z');

describe('unavailableVideos', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'unavailable-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  /** The record file as a hand-edited folder would hold it */
  async function writeRecord(data: unknown): Promise<void> {
    await fs.writeFile(path.join(dir, UNAVAILABLE_FILE), JSON.stringify(data), 'utf-8');
  }

  describe('availabilitySkipReason', () => {
    it('maps members-only availability to its skip reason', () => {
      expect(availabilitySkipReason('subscriber_only')).toBe('members-only');
    });

    it('maps Premium-only availability to its skip reason', () => {
      expect(availabilitySkipReason('premium_only')).toBe('premium-only');
    });

    it('leaves public and less certain availability values alone', () => {
      expect(availabilitySkipReason('public')).toBeNull();
      expect(availabilitySkipReason('needs_auth')).toBeNull();
      expect(availabilitySkipReason('private')).toBeNull();
      expect(availabilitySkipReason(undefined)).toBeNull();
    });
  });

  describe('unavailableSkipReason', () => {
    it('reports the availability reason before the recorded one', () => {
      const reason = unavailableSkipReason({
        availability: 'subscriber_only',
        recorded: { code: 'removed', at: new Date(NOW).toISOString() },
        now: NOW,
      });
      expect(reason).toBe('members-only');
    });

    it('reports a fresh recorded failure when the catalog says nothing', () => {
      const reason = unavailableSkipReason({
        availability: undefined,
        recorded: { code: 'removed', at: new Date(NOW - 1000).toISOString() },
        now: NOW,
      });
      expect(reason).toBe('removed');
    });

    it('forgets a recorded failure once the TTL has passed', () => {
      const reason = unavailableSkipReason({
        availability: undefined,
        recorded: { code: 'removed', at: new Date(NOW - UNAVAILABLE_TTL_MS).toISOString() },
        now: NOW,
      });
      expect(reason).toBeNull();
    });

    it('ignores a recorded failure whose date cannot be read', () => {
      const reason = unavailableSkipReason({
        availability: undefined,
        recorded: { code: 'removed', at: 'yesterday' },
        now: NOW,
      });
      expect(reason).toBeNull();
    });

    it('ignores codes that describe the machine, not the video', () => {
      const reason = unavailableSkipReason({
        availability: undefined,
        recorded: { code: 'no-space', at: new Date(NOW).toISOString() },
        now: NOW,
      });
      expect(reason).toBeNull();
    });
  });

  describe('readUnavailable', () => {
    it('answers an empty record for a folder without the file', async () => {
      await expect(readUnavailable(dir)).resolves.toEqual({ version: 1, entries: {} });
    });

    it('reads the entries a previous run wrote', async () => {
      await writeRecord({
        version: 1,
        entries: { [MEMBERS_ONLY]: { code: 'members-only', at: '2026-10-01T00:00:00.000Z' } },
      });
      const record = await readUnavailable(dir);
      expect(record.entries[MEMBERS_ONLY]).toEqual({ code: 'members-only', at: '2026-10-01T00:00:00.000Z' });
    });

    it('answers an empty record for a corrupt file instead of throwing', async () => {
      await fs.writeFile(path.join(dir, UNAVAILABLE_FILE), '{ not json', 'utf-8');
      await expect(readUnavailable(dir)).resolves.toEqual({ version: 1, entries: {} });
    });

    it('drops entries that a hand-edited file could not have come from this app', async () => {
      await writeRecord({
        version: 1,
        entries: {
          [MEMBERS_ONLY]: { code: 'members-only', at: '2026-10-01T00:00:00.000Z' },
          '../../etc/passwd': { code: 'removed', at: '2026-10-01T00:00:00.000Z' },
          short: { code: 'removed', at: '2026-10-01T00:00:00.000Z' },
          [PREMIUM_ONLY]: { code: 'no-space', at: '2026-10-01T00:00:00.000Z' },
          second: { code: 'removed' },
        },
      });
      const record = await readUnavailable(dir);
      expect(Object.keys(record.entries)).toEqual([MEMBERS_ONLY]);
    });
  });

  describe('recordUnavailable', () => {
    it('writes the code and the moment of the failure', async () => {
      await recordUnavailable(dir, [MEMBERS_ONLY], 'members-only', NOW);
      await expect(readUnavailable(dir)).resolves.toEqual({
        version: 1,
        entries: { [MEMBERS_ONLY]: { code: 'members-only', at: new Date(NOW).toISOString() } },
      });
    });

    it('adds to the entries already recorded', async () => {
      await recordUnavailable(dir, [MEMBERS_ONLY], 'members-only', NOW);
      await recordUnavailable(dir, [PREMIUM_ONLY], 'removed', NOW);
      const record = await readUnavailable(dir);
      expect(Object.keys(record.entries).sort()).toEqual([PREMIUM_ONLY, MEMBERS_ONLY].sort());
    });

    it('keeps both entries when two jobs of one folder finish together', async () => {
      await Promise.all([
        recordUnavailable(dir, [MEMBERS_ONLY], 'members-only', NOW),
        recordUnavailable(dir, [PREMIUM_ONLY], 'removed', NOW),
      ]);
      const record = await readUnavailable(dir);
      expect(Object.keys(record.entries).sort()).toEqual([PREMIUM_ONLY, MEMBERS_ONLY].sort());
    });

    it('refuses a code that is not a video-level failure', async () => {
      await recordUnavailable(dir, [MEMBERS_ONLY], 'no-space', NOW);
      await expect(readUnavailable(dir)).resolves.toEqual({ version: 1, entries: {} });
    });

    it('refuses an id that is not a YouTube video id', async () => {
      await recordUnavailable(dir, ['../../etc/passwd', 'short'], 'removed', NOW);
      await expect(readUnavailable(dir)).resolves.toEqual({ version: 1, entries: {} });
    });

    it('writes nothing when no id survives the check', async () => {
      await recordUnavailable(dir, [], 'removed', NOW);
      await expect(fs.access(path.join(dir, UNAVAILABLE_FILE))).rejects.toThrow();
    });
  });

  describe('clearUnavailable', () => {
    it('removes only the ids it is given', async () => {
      await recordUnavailable(dir, [MEMBERS_ONLY, PREMIUM_ONLY], 'removed', NOW);
      await clearUnavailable(dir, [MEMBERS_ONLY]);
      const record = await readUnavailable(dir);
      expect(Object.keys(record.entries)).toEqual([PREMIUM_ONLY]);
    });

    it('is quiet when the folder has no record at all', async () => {
      await expect(clearUnavailable(dir, [MEMBERS_ONLY])).resolves.toBeUndefined();
    });
  });
});
