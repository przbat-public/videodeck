import { describeError, LogThrottle } from './logThrottle';

describe('LogThrottle', () => {
  it('prints the first occurrence and stays quiet inside the window', () => {
    const throttle = new LogThrottle(30_000);

    expect(throttle.shouldLog(1_000)).toBe(true);
    expect(throttle.shouldLog(1_001)).toBe(false);
    expect(throttle.shouldLog(30_999)).toBe(false);
  });

  it('prints again once the window has passed', () => {
    const throttle = new LogThrottle(30_000);

    expect(throttle.shouldLog(1_000)).toBe(true);
    expect(throttle.shouldLog(31_000)).toBe(true);
  });

  it('forgets the window on reset', () => {
    const throttle = new LogThrottle(30_000);

    throttle.shouldLog(1_000);
    throttle.reset();

    expect(throttle.shouldLog(1_001)).toBe(true);
  });
});

describe('describeError', () => {
  it('joins the cause chain without repeating the same text', () => {
    const inner = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:9200'), { name: 'ConnectionError' });
    const outer = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:9200'), { name: 'ConnectionError' });
    outer.cause = inner;

    expect(describeError(outer)).toBe('ConnectionError: connect ECONNREFUSED 127.0.0.1:9200');
  });

  it('keeps both levels when they say different things', () => {
    const inner = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:9200'), { name: 'ConnectionError' });
    const outer = Object.assign(new Error('Request failed'), { name: 'ResponseError' });
    outer.cause = inner;

    expect(describeError(outer)).toBe(
      'ResponseError: Request failed <- ConnectionError: connect ECONNREFUSED 127.0.0.1:9200',
    );
  });

  it('describes a non-error value', () => {
    expect(describeError('boom')).toBe('');
  });
});
