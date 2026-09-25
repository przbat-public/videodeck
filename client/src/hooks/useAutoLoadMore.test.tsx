import { act, render, screen } from '@testing-library/react';
import type { JSX } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installIntersectionObserver } from '../test/intersectionObserverMock';
import { useAutoLoadMore } from './useAutoLoadMore';

function Harness({ enabled, onLoadMore }: { enabled: boolean; onLoadMore: () => void }): JSX.Element {
  const endRef = useAutoLoadMore<HTMLDivElement>(onLoadMore, enabled);
  return <div ref={endRef} data-testid="end" />;
}

describe('useAutoLoadMore', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('loads more once the end of the list comes near the bottom of the viewport', () => {
    const observers = installIntersectionObserver();
    const onLoadMore = vi.fn();
    render(<Harness enabled onLoadMore={onLoadMore} />);

    const observer = observers.at(-1);
    expect(observer?.targets).toEqual([screen.getByTestId('end')]);
    // The next page starts loading before the user hits the bottom
    expect(observer?.options?.rootMargin).toBe('0px 0px 600px 0px');

    act(() => observer?.trigger(false));
    expect(onLoadMore).not.toHaveBeenCalled();
    act(() => observer?.trigger(true));
    expect(onLoadMore).toHaveBeenCalledTimes(1);
  });

  it('watches nothing while disabled and lets go of the end when disabled again', () => {
    const observers = installIntersectionObserver();
    const onLoadMore = vi.fn();
    const { rerender } = render(<Harness enabled={false} onLoadMore={onLoadMore} />);
    expect(observers).toHaveLength(0);

    rerender(<Harness enabled onLoadMore={onLoadMore} />);
    expect(observers).toHaveLength(1);

    rerender(<Harness enabled={false} onLoadMore={onLoadMore} />);
    expect(observers[0]?.disconnected).toBe(true);
  });

  it('leaves loading to the button where the browser has no IntersectionObserver', () => {
    vi.stubGlobal('IntersectionObserver', undefined);

    expect(() => render(<Harness enabled onLoadMore={vi.fn()} />)).not.toThrow();
  });
});
