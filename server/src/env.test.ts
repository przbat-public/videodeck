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

  describe('summary provider variables', () => {
    it('accepts either provider name and the DeepSeek settings', () => {
      const env = validateEnv({
        ...BASE,
        SUMMARY_PROVIDER: 'deepseek',
        DEEPSEEK_API_KEY: 'ds-key',
        DEEPSEEK_MODEL: 'deepseek-v4-pro',
        DEEPSEEK_BASE_URL: 'http://127.0.0.1:9200/v1',
      });

      expect(env.SUMMARY_PROVIDER).toBe('deepseek');
      expect(env.DEEPSEEK_MODEL).toBe('deepseek-v4-pro');
      expect(validateEnv({ ...BASE, SUMMARY_PROVIDER: 'openai' }).SUMMARY_PROVIDER).toBe('openai');
    });

    it('rejects a provider name that is not one of the two', () => {
      expect(() => validateEnv({ ...BASE, SUMMARY_PROVIDER: 'deepsek' })).toThrow(/SUMMARY_PROVIDER/);
    });

    it('rejects a base URL that is not a URL', () => {
      expect(() => validateEnv({ ...BASE, DEEPSEEK_BASE_URL: 'api.deepseek.com' })).toThrow(/DEEPSEEK_BASE_URL/);
    });

    it('keeps an unconfigured provider bootable, because summaries are optional', () => {
      expect(validateEnv({ ...BASE }).SUMMARY_PROVIDER).toBeUndefined();
    });
  });

  describe('unauthenticated API on a public interface', () => {
    it('refuses to start when HOST is not loopback and no token is configured', () => {
      expect(() => validateEnv({ ...BASE, HOST: '0.0.0.0' })).toThrow(/unauthenticated API on 0\.0\.0\.0/);
      expect(() => validateEnv({ ...BASE, HOST: '192.168.1.10' })).toThrow(/unauthenticated API/);
    });

    it('accepts a public interface once a token or REQUIRE_API_TOKEN is set', () => {
      expect(validateEnv({ ...BASE, HOST: '0.0.0.0', API_TOKEN: 'sekret' }).HOST).toBe('0.0.0.0');
      expect(validateEnv({ ...BASE, HOST: '0.0.0.0', REQUIRE_API_TOKEN: 'true' }).HOST).toBe('0.0.0.0');
    });

    it('treats an empty or blank API_TOKEN as no token at all', () => {
      // docker-compose renders `API_TOKEN=${API_TOKEN:-}`, so an unset variable
      // reaches the server as an empty string. Reading that as "configured"
      // let the guard below pass while every request was served unauthenticated.
      expect(() => validateEnv({ ...BASE, HOST: '0.0.0.0', API_TOKEN: '' })).toThrow(/unauthenticated API/);
      expect(() => validateEnv({ ...BASE, HOST: '0.0.0.0', API_TOKEN: '   ' })).toThrow(/unauthenticated API/);
    });

    it('keeps the loopback default unauthenticated, which is the dev setup', () => {
      expect(validateEnv({ ...BASE }).HOST).toBe('127.0.0.1');
      expect(validateEnv({ ...BASE, HOST: 'localhost' }).HOST).toBe('localhost');
      expect(validateEnv({ ...BASE, HOST: '::1' }).HOST).toBe('::1');
    });
  });

  describe('trust proxy', () => {
    it('refuses a bare true, which trusts every hop in front of the server', () => {
      expect(() => validateEnv({ ...BASE, TRUST_PROXY: 'true' })).toThrow(/TRUST_PROXY/);
      expect(() => validateEnv({ ...BASE, TRUST_PROXY: ' TRUE ' })).toThrow(/TRUST_PROXY/);
    });

    it('accepts a hop count, false, loopback and a subnet', () => {
      expect(validateEnv({ ...BASE, TRUST_PROXY: '1' }).TRUST_PROXY).toBe('1');
      expect(validateEnv({ ...BASE, TRUST_PROXY: 'false' }).TRUST_PROXY).toBe('false');
      expect(validateEnv({ ...BASE, TRUST_PROXY: 'loopback' }).TRUST_PROXY).toBe('loopback');
      expect(validateEnv({ ...BASE, TRUST_PROXY: '10.0.0.0/8' }).TRUST_PROXY).toBe('10.0.0.0/8');
    });
  });
});
