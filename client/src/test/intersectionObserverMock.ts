import { vi } from 'vitest';

/** One observer the code under test created, with a way to fire it */
export interface FakeIntersectionObserver {
  options: IntersectionObserverInit | undefined;
  targets: Element[];
  disconnected: boolean;
  /** Report every observed element as entering (true) or leaving (false) the root */
  trigger: (isIntersecting: boolean) => void;
}

/**
 * jsdom has no IntersectionObserver. This stubs one for the current test and
 * returns the observers the code creates, newest last. Pair it with
 * `vi.unstubAllGlobals()` in `afterEach`.
 */
export function installIntersectionObserver(): FakeIntersectionObserver[] {
  const observers: FakeIntersectionObserver[] = [];

  class FakeObserver {
    private readonly fake: FakeIntersectionObserver;

    constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
      const fake: FakeIntersectionObserver = {
        options,
        targets: [],
        disconnected: false,
        trigger: (isIntersecting) => {
          const entries = fake.targets.map((target) => ({ target, isIntersecting }) as IntersectionObserverEntry);
          callback(entries, this as unknown as IntersectionObserver);
        },
      };
      this.fake = fake;
      observers.push(fake);
    }

    observe(target: Element): void {
      this.fake.targets.push(target);
    }

    unobserve(target: Element): void {
      this.fake.targets = this.fake.targets.filter((observed) => observed !== target);
    }

    disconnect(): void {
      this.fake.disconnected = true;
      this.fake.targets = [];
    }

    takeRecords(): IntersectionObserverEntry[] {
      return [];
    }
  }

  vi.stubGlobal('IntersectionObserver', FakeObserver);
  return observers;
}
