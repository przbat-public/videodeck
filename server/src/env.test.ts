import { validateEnv } from './env';

const BASE = {
  VIDEOS_FOLDER_PATH: '/test/videos',
} as NodeJS.ProcessEnv;

describe('validateEnv', () => {
  it('accepts a minimal valid environment and applies the defaults', () => {
    const env = validateEnv({ ...BASE });

    expect(env.PORT).toBe(3001);
    expect(env.HOST).toBe('127.0.0.1');
    expect(env.ELASTICSEARCH_URL).toBe('http://localhost:9200');
  });

  it('accepts and coerces a fully configured environment', () => {
    const env = validateEnv({
      ...BASE,
      PORT: '4000',
      HOST: '0.0.0.0',
      API_TOKEN: 'sekret',
      DOWNLOAD_CONCURRENCY: '4',
      UPDATE_CONCURRENCY: '3',
      DOWNLOAD_MAX_ATTEMPTS: '5',
      RATE_LIMIT_MAX: '100',
      RATE_LIMIT_WINDOW_MS: '60000',
      LOG_LEVEL: 'warn',
    });

    expect(env.PORT).toBe(4000);
    expect(env.DOWNLOAD_CONCURRENCY).toBe(4);
    expect(env.UPDATE_CONCURRENCY).toBe(3);
    expect(env.DOWNLOAD_MAX_ATTEMPTS).toBe(5);
    expect(env.LOG_LEVEL).toBe('warn');
  });

  it('rejects a missing VIDEOS_FOLDER_PATH', () => {
    expect(() => validateEnv({})).toThrow(/VIDEOS_FOLDER_PATH/);
  });

  it('lists every invalid variable in one error', () => {
    const failing = {
      VIDEOS_FOLDER_PATH: '/x',
      PORT: 'not-a-number',
      DOWNLOAD_CONCURRENCY: 'zero',
      LOG_LEVEL: 'loud',
    };
    let message = '';
    try {
      validateEnv(failing);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain('PORT');
    expect(message).toContain('DOWNLOAD_CONCURRENCY');
    expect(message).toContain('LOG_LEVEL');
  });

  it('rejects out-of-range ports', () => {
    expect(() => validateEnv({ ...BASE, PORT: '70000' })).toThrow(/PORT/);
    expect(() => validateEnv({ ...BASE, PORT: '0' })).toThrow(/PORT/);
  });
});
