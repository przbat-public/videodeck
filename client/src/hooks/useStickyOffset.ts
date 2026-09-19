import type { RefObject } from 'react';
import { useEffect } from 'react';

/**
 * Publishes the height of a sticky bar as a CSS custom property on an
 * ancestor element, so a second sticky element can sit right below it. The
 * console's table header uses it: the queue bar above it wraps on narrower
 * screens, so a constant offset would hide the header behind the bar.
 *
 * The property is written once on mount and again whenever the bar resizes.
 * A bar that is not mounted yet is not an error: there is simply nothing to
 * measure until it renders.
 */
export function useStickyOffset(
  containerRef: RefObject<HTMLElement | null>,
  barRef: RefObject<HTMLElement | null>,
  property: string,
): void {
  useEffect(() => {
    const container = containerRef.current;
    const bar = barRef.current;
    if (container === null || bar === null) {
      return; // nothing rendered yet, or already gone
    }
    const sync = (): void => {
      container.style.setProperty(property, `${bar.offsetHeight}px`);
    };
    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(bar);
    return () => observer.disconnect();
  }, [containerRef, barRef, property]);
}
