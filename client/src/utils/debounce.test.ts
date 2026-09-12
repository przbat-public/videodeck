import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { debounce } from './debounce';

describe('debounce', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs the callback once the delay has passed', () => {
    const fn = vi.fn();
    const debounced = debounce(fn, 300);

    debounced('a');
    expect(fn).not.toHaveBeenCalled();

    vi.advanceTimersByTime(300);
    expect(fn).toHaveBeenCalledExactlyOnceWith('a');
  });

  it('collapses rapid calls into one, keeping the last arguments', () => {
    const fn = vi.fn();
    const debounced = debounce(fn, 300);

    debounced('a');
    vi.advanceTimersByTime(100);
    debounced('b');
    vi.advanceTimersByTime(100);
    debounced('c');
    vi.advanceTimersByTime(300);

    expect(fn).toHaveBeenCalledExactlyOnceWith('c');
  });

  it('cancel drops a pending call', () => {
    const fn = vi.fn();
    const debounced = debounce(fn, 300);

    debounced('a');
    debounced.cancel();
    vi.advanceTimersByTime(1000);

    expect(fn).not.toHaveBeenCalled();
  });

  it('cancel is a no-op when nothing is scheduled', () => {
    const fn = vi.fn();
    const debounced = debounce(fn, 300);

    expect(() => debounced.cancel()).not.toThrow();
    expect(fn).not.toHaveBeenCalled();
  });

  it('allows a new call after one has fired', () => {
    const fn = vi.fn();
    const debounced = debounce(fn, 300);

    debounced('first');
    vi.advanceTimersByTime(300);
    debounced('second');
    vi.advanceTimersByTime(300);

    expect(fn).toHaveBeenCalledTimes(2);
    expect(fn).toHaveBeenLastCalledWith('second');
  });

  it('passes every argument through', () => {
    const fn = vi.fn();
    const debounced = debounce(fn, 300);

    debounced('query', 'date-desc');
    vi.advanceTimersByTime(300);

    expect(fn).toHaveBeenCalledExactlyOnceWith('query', 'date-desc');
  });
});
