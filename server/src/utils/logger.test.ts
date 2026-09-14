import { formatLogLine, logger } from './logger';

describe('formatLogLine', () => {
  it('prefixes the message with a timestamp and the level', () => {
    const line = formatLogLine('error', 'boom');
    expect(line).toMatch(/^\[\d{4}-\d{2}-\d{2}T[\d:.]+Z\] \[ERROR\] boom$/);
  });

  it('uppercases every level', () => {
    expect(formatLogLine('info', 'x')).toContain('[INFO]');
    expect(formatLogLine('warn', 'x')).toContain('[WARN]');
    expect(formatLogLine('error', 'x')).toContain('[ERROR]');
  });
});

describe('logger', () => {
  it('routes every level to the matching console method', () => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});

    logger.info('a');
    logger.warn('b');
    logger.error('c', new Error('d'));

    // Assert before restoring: mockRestore() on a console spy drops its calls.
    expect(log).toHaveBeenCalledWith(expect.stringContaining('a'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('b'));
    expect(error).toHaveBeenCalledWith(expect.stringContaining('c'), expect.any(Error));

    log.mockRestore();
    warn.mockRestore();
    error.mockRestore();
  });

  it('respects LOG_LEVEL', () => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      process.env.LOG_LEVEL = 'warn';
      logger.info('hidden');
      logger.warn('shown');
      expect(log).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('shown'));

      process.env.LOG_LEVEL = 'silent';
      logger.error('also hidden');
      expect(error).not.toHaveBeenCalled();

      process.env.LOG_LEVEL = 'bogus';
      logger.info('visible again');
      expect(log).toHaveBeenCalledWith(expect.stringContaining('visible again'));
    } finally {
      delete process.env.LOG_LEVEL;
      log.mockRestore();
      warn.mockRestore();
      error.mockRestore();
    }
  });
});
