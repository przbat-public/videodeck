/**
 * The runner contract the server suite leans on: no mock answer outlives the
 * test that installed it (mockReset in vitest.config.mts). Vitest's default,
 * clearMocks, empties the call log but keeps both the implementation and the
 * queued once-answers, so a stub set in one test answered the next one, and
 * the shuffled nightly decided which tests passed.
 *
 * The two tests run in declaration order whatever the shuffle setting: the
 * second one observes what the first one left behind. Run on its own, the
 * second one passes either way, because nothing ran before it.
 */
describe('mock isolation between tests', { shuffle: false }, () => {
  const leftover = vi.fn<() => string | undefined>();

  it('installs a standing answer and a queued one, and consumes neither', () => {
    leftover.mockReturnValue('standing');
    leftover.mockReturnValueOnce('queued');

    expect(leftover).not.toHaveBeenCalled();
  });

  it('starts the next test with neither answer left', () => {
    expect(leftover()).toBeUndefined();
  });
});

describe('mock isolation and the hooks of a test', () => {
  const fromHook = vi.fn<() => string | undefined>();

  // The reset runs before beforeEach, so a default a hook installs is what
  // the test sees. A reset after the hooks would leave every such default
  // undefined.
  beforeEach(() => {
    fromHook.mockReturnValue('hook');
  });

  it('keeps the default a beforeEach installs', () => {
    expect(fromHook()).toBe('hook');
  });
});
