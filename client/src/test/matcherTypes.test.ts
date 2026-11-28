import { describe, type expect, expectTypeOf, it } from 'vitest';

/**
 * jest-dom adds its matchers to vitest's Assertion interface, so the two have
 * to agree on that interface's type parameters (jest-dom 8 is written for
 * vitest 5). When they drift, skipLibCheck hides the clash inside the .d.ts
 * files and TypeScript merges the parameters by name: every matcher call
 * still compiles but returns the element instead of void, which is how
 * jest-dom 7 ran against vitest 5 unnoticed. These checks fail the client
 * typecheck instead.
 */

/** The assertion vitest hands a test for an element */
type ElementAssertion = ReturnType<typeof expect<HTMLElement>>;

describe('jest-dom matcher types', () => {
  it('return what vitest assertions return', () => {
    expectTypeOf<ReturnType<ElementAssertion['toBeInTheDocument']>>().toEqualTypeOf<void>();
    expectTypeOf<ReturnType<ElementAssertion['resolves']['toBeInTheDocument']>>().toEqualTypeOf<Promise<void>>();
  });
});
