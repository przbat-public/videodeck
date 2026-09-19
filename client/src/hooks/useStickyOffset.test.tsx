import { render, screen } from '@testing-library/react';
import type { JSX } from 'react';
import { useRef } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { useStickyOffset } from './useStickyOffset';

/** Counts the observer lifecycle, so the cleanup is observable in jsdom */
class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];
  observed: Element[] = [];
  disconnected = false;

  constructor(private readonly onResize: () => void) {
    FakeResizeObserver.instances.push(this);
  }

  observe(target: Element): void {
    this.observed.push(target);
  }

  unobserve(): void {
    /* the hook disconnects instead */
  }

  disconnect(): void {
    this.disconnected = true;
  }

  /** jsdom has no layout, so the tests fire the callback by hand */
  trigger(): void {
    this.onResize();
  }
}

const originalResizeObserver = globalThis.ResizeObserver;

const setObserver = (): void => {
  FakeResizeObserver.instances = [];
  globalThis.ResizeObserver = FakeResizeObserver as unknown as typeof ResizeObserver;
};

afterEach(() => {
  globalThis.ResizeObserver = originalResizeObserver;
});

/** A page-shaped component: the bar inside the container the property lands on */
function Page({ property = '--bar-height' }: { property?: string }): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  useStickyOffset(containerRef, barRef, property);
  return (
    <div data-testid="page" ref={containerRef}>
      <div data-testid="bar" ref={barRef} />
    </div>
  );
}

/** The same hook with refs that were never attached to an element */
function Unmounted(): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  useStickyOffset(containerRef, barRef, '--bar-height');
  return <p>nothing to measure</p>;
}

describe('useStickyOffset', () => {
  it('publishes the bar height on the container and keeps watching it', () => {
    setObserver();
    const { unmount } = render(<Page />);

    // jsdom has no layout, so the height is zero. What matters is that the
    // property lands on the ancestor the stylesheet reads it from.
    const page = screen.getByTestId('page');
    expect(page.style.getPropertyValue('--bar-height')).toBe('0px');
    const [observer] = FakeResizeObserver.instances;
    expect(observer?.observed).toEqual([screen.getByTestId('bar')]);

    // A resize writes the property again instead of leaving a stale offset
    observer?.trigger();
    expect(page.style.getPropertyValue('--bar-height')).toBe('0px');

    unmount();
    expect(observer?.disconnected).toBe(true);
  });

  it('does nothing while the elements are not rendered', () => {
    setObserver();
    render(<Unmounted />);

    expect(FakeResizeObserver.instances).toHaveLength(0);
    expect(document.querySelector('[style]')).toBeNull();
  });

  it('writes whichever property name it is given', () => {
    setObserver();
    const { rerender } = render(<Page />);

    rerender(<Page property="--other-name" />);

    expect(screen.getByTestId('page').style.getPropertyValue('--other-name')).toBe('0px');
  });
});
