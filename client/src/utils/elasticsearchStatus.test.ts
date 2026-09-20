import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getElasticsearchState,
  reportElasticsearchReachable,
  reportElasticsearchUnavailable,
  resetElasticsearchState,
  setElasticsearchState,
  subscribeElasticsearchState,
} from './elasticsearchStatus';

describe('elasticsearchStatus store', () => {
  beforeEach(() => {
    resetElasticsearchState();
  });

  it('starts unknown and takes a request report', () => {
    expect(getElasticsearchState()).toBe('unknown');

    reportElasticsearchReachable();

    expect(getElasticsearchState()).toBe('ok');
  });

  it('keeps the outage until the health probe clears it', () => {
    // A request failed, so the banner is up
    reportElasticsearchUnavailable();
    expect(getElasticsearchState()).toBe('down');

    // A single status read that happened to work must not hide it
    reportElasticsearchReachable();
    expect(getElasticsearchState()).toBe('down');

    // The probe is the authority in both directions
    setElasticsearchState('ok');
    expect(getElasticsearchState()).toBe('ok');
  });

  it('notifies subscribers until they unsubscribe', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeElasticsearchState(listener);

    reportElasticsearchUnavailable();
    expect(listener).toHaveBeenCalledTimes(1);

    // The same value twice is not a change
    reportElasticsearchUnavailable();
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    setElasticsearchState('ok');
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
