import { installShutdownHandlers, shutdown } from './shutdown';

describe('shutdown', () => {
  it('cancels the jobs, closes the server and exits 0', () => {
    const cancelJobs = jest.fn();
    const exit = jest.fn();
    const close = jest.fn((callback?: () => void) => callback?.());

    shutdown({ server: { close }, cancelJobs, exit, forceExitMs: 1000 });

    expect(cancelJobs).toHaveBeenCalled();
    expect(close).toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('forces an exit when the server does not close in time', () => {
    jest.useFakeTimers();
    const exit = jest.fn();

    shutdown({
      server: { close: jest.fn() },
      cancelJobs: jest.fn(),
      exit,
      forceExitMs: 5000,
    });

    expect(exit).not.toHaveBeenCalled();
    jest.advanceTimersByTime(5000);
    expect(exit).toHaveBeenCalledWith(1);

    jest.useRealTimers();
  });

  it('exits 1 when closing the server throws', () => {
    const exit = jest.fn();
    const close = jest.fn(() => {
      throw new Error('close failed');
    });

    shutdown({ server: { close }, cancelJobs: jest.fn(), exit });

    expect(exit).toHaveBeenCalledWith(1);
  });

  it('ends open SSE streams before closing the server', () => {
    const closeSseStreams = jest.fn();
    const exit = jest.fn();
    const close = jest.fn((callback?: () => void) => callback?.());

    shutdown({ server: { close }, cancelJobs: jest.fn(), exit, closeSseStreams });

    expect(closeSseStreams).toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('waits for the download queue to drain before closing the server', async () => {
    const cancelJobs = jest.fn();
    const exit = jest.fn();
    const close = jest.fn((callback?: () => void) => callback?.());
    let releaseIdle: (() => void) | undefined;
    const awaitIdle = jest.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseIdle = resolve;
        }),
    );

    shutdown({ server: { close }, cancelJobs, exit, awaitIdle, forceExitMs: 1000 });

    expect(cancelJobs).toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();

    releaseIdle?.();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(close).toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(0);
  });
});

describe('installShutdownHandlers', () => {
  it('registers and unregisters the signal handlers', () => {
    const options = {
      server: { close: jest.fn((callback?: () => void) => callback?.()) },
      cancelJobs: jest.fn(),
      exit: jest.fn(),
    };
    const remove = installShutdownHandlers(options, ['SIGTERM']);

    expect(process.listenerCount('SIGTERM')).toBeGreaterThan(0);
    remove();
    expect(process.listenerCount('SIGTERM')).toBe(0);
  });
});
