import { describe, expect, it } from 'vitest';
import { groupChannelsByCategory } from './channelGroups';

describe('groupChannelsByCategory', () => {
  it('sorts the categories and the channels inside them', () => {
    expect(
      groupChannelsByCategory(['Zulu', 'Beta', 'Alpha'], {
        Zulu: 'psychology',
        Beta: 'fpv',
        Alpha: 'fpv',
      }),
    ).toEqual([
      { category: 'fpv', channels: ['Alpha', 'Beta'] },
      { category: 'psychology', channels: ['Zulu'] },
    ]);
  });

  it('keeps the channels whose folder declares no category in the last section', () => {
    expect(groupChannelsByCategory(['Mike', 'Alpha'], { Alpha: 'fpv' })).toEqual([
      { category: 'fpv', channels: ['Alpha'] },
      { category: '', channels: ['Mike'] },
    ]);
  });

  it('returns one headerless section when no channel has a category', () => {
    expect(groupChannelsByCategory(['Beta', 'Alpha'], {})).toEqual([{ category: '', channels: ['Alpha', 'Beta'] }]);
  });

  it('returns nothing for an empty list', () => {
    expect(groupChannelsByCategory([], { Alpha: 'fpv' })).toEqual([]);
  });
});
