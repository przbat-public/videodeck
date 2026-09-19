import type { ChannelVideo } from '@videodeck/shared/api';
import { describe, expect, it } from 'vitest';
import { selectDownloadable, selectDownloaded, selectStale } from './videoSelection';

const video = (id: string, url = `https://youtu.be/${id}`): ChannelVideo => ({ id, title: `Film ${id}`, url });

const NOW = Date.parse('2026-09-19T12:00:00.000Z');
const daysAgo = (days: number): string => new Date(NOW - days * 24 * 60 * 60 * 1000).toISOString();

const ids = (videos: readonly ChannelVideo[]): string[] => videos.map((entry) => entry.id);

describe('videoSelection', () => {
  it('selects the videos worth downloading: not downloaded and with a url', () => {
    const videos = [video('a'), video('b'), video('c', '')];

    expect(ids(selectDownloadable(videos, { a: true }))).toEqual(['b']);
  });

  it('selects the downloaded videos, ignoring the ones without a url', () => {
    const videos = [video('a'), video('b'), video('c', '')];

    expect(ids(selectDownloaded(videos, { a: true, c: true }))).toEqual(['a']);
  });

  it('selects the stale downloads and skips the fresh ones', () => {
    const videos = [video('a'), video('b'), video('c'), video('d')];
    const downloaded = { a: true, b: true, c: true };
    const lastUpdated = { a: daysAgo(45), b: daysAgo(2), c: 'not-a-date' };

    expect(ids(selectStale(videos, downloaded, lastUpdated, NOW))).toEqual(['a', 'c']);
  });

  it('treats a download without a known date as stale, but never a missing download', () => {
    const videos = [video('a'), video('b')];

    expect(ids(selectStale(videos, { a: true }, {}, NOW))).toEqual(['a']);
  });
});
