import {
  DEEPSEEK_DEFAULT_BASE_URL,
  DEEPSEEK_DEFAULT_MODEL,
  DEEPSEEK_INPUT_BUDGET,
  OPENAI_SUMMARY_MODELS,
  parseDeepSeekModel,
  resolveSummaryProvider,
  type SummaryProviderProfile,
  type SummaryProviderResolution,
} from './llmProviders';

/**
 * Put an environment variable back the way this file found it: process.env
 * outlives a test file inside a jest worker, and the deep server integration
 * runs as a neighbour (see config.test.ts).
 */
function restoreEnv(name: string, original: string | undefined): void {
  if (original === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = original;
  }
}

/** The provider of a resolution that must be ready, or a loud test failure */
function readyProfile(resolution: SummaryProviderResolution): SummaryProviderProfile {
  if (resolution.status !== 'ready') {
    throw new Error(`expected a configured provider, got: ${resolution.message}`);
  }
  return resolution.profile;
}

const PROVIDER_VARS = [
  'SUMMARY_PROVIDER',
  'DEEPSEEK_API_KEY',
  'DEEPSEEK_MODEL',
  'DEEPSEEK_BASE_URL',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
] as const;

describe('resolveSummaryProvider', () => {
  const original = new Map(PROVIDER_VARS.map((name) => [name, process.env[name]]));

  beforeEach(() => {
    for (const name of PROVIDER_VARS) {
      delete process.env[name];
    }
  });

  afterAll(() => {
    for (const [name, value] of original) {
      restoreEnv(name, value);
    }
  });

  it('selects DeepSeek when only the DeepSeek key is set', () => {
    process.env.DEEPSEEK_API_KEY = 'ds-key';

    const profile = readyProfile(resolveSummaryProvider());

    expect(profile.id).toBe('deepseek');
    expect(profile.apiKey).toBe('ds-key');
    expect(profile.baseUrl).toBe(DEEPSEEK_DEFAULT_BASE_URL);
    expect(profile.models.map((model) => model.name)).toEqual([DEEPSEEK_DEFAULT_MODEL]);
    expect(profile.models[0]?.inputBudget).toBe(DEEPSEEK_INPUT_BUDGET);
  });

  it('disables the DeepSeek thinking mode by default, which would otherwise bill for reasoning', () => {
    process.env.DEEPSEEK_API_KEY = 'ds-key';

    const model = readyProfile(resolveSummaryProvider()).models[0];

    expect(model?.extras).toEqual({ thinking: { type: 'disabled' } });
  });

  it('turns `name:effort` into thinking mode with that effort', () => {
    process.env.DEEPSEEK_API_KEY = 'ds-key';
    process.env.DEEPSEEK_MODEL = 'deepseek-v4-pro:high';

    const model = readyProfile(resolveSummaryProvider()).models[0];

    expect(model?.name).toBe('deepseek-v4-pro');
    expect(model?.extras).toEqual({ thinking: { type: 'enabled' }, reasoning_effort: 'high' });
    // Thinking mode ignores the sampling temperature, so the request omits it
    expect(model?.temperature).toBeUndefined();
    // ...and it spends output tokens on reasoning, so the cap is higher
    expect(model?.maxTokens).toBeGreaterThan(2000);
    // The price follows the bare model name, not the suffixed value
    expect(model?.prices).toEqual([0.66, 1.98]);
  });

  it('treats `:none` as the explicit spelling of thinking off', () => {
    process.env.DEEPSEEK_API_KEY = 'ds-key';
    process.env.DEEPSEEK_MODEL = 'deepseek-flash:none';

    const model = readyProfile(resolveSummaryProvider()).models[0];

    expect(model?.name).toBe('deepseek-flash');
    expect(model?.extras).toEqual({ thinking: { type: 'disabled' } });
    expect(model?.temperature).toBe(0.7);
  });

  it('selects OpenAI when only the OpenAI key is set', () => {
    process.env.OPENAI_API_KEY = 'sk-key';

    const profile = readyProfile(resolveSummaryProvider());

    expect(profile.id).toBe('openai');
    expect(profile.apiKey).toBe('sk-key');
    expect(profile.models.map((model) => model.name)).toEqual(OPENAI_SUMMARY_MODELS.map((model) => model.name));
    expect(profile.models.map((model) => model.inputBudget)).toEqual(
      OPENAI_SUMMARY_MODELS.map((model) => model.inputBudget),
    );
    expect(profile.models.every((model) => model.extras === undefined)).toBe(true);
  });

  it('prefers DeepSeek when both keys are present, which is the one-line switch', () => {
    process.env.OPENAI_API_KEY = 'sk-key';
    process.env.DEEPSEEK_API_KEY = 'ds-key';

    expect(readyProfile(resolveSummaryProvider()).id).toBe('deepseek');
  });

  it('lets SUMMARY_PROVIDER=openai pin OpenAI while both keys are present', () => {
    process.env.OPENAI_API_KEY = 'sk-key';
    process.env.DEEPSEEK_API_KEY = 'ds-key';
    process.env.SUMMARY_PROVIDER = 'openai';

    expect(readyProfile(resolveSummaryProvider()).id).toBe('openai');
  });

  it('lets SUMMARY_PROVIDER=deepseek pin DeepSeek without a second key', () => {
    process.env.DEEPSEEK_API_KEY = 'ds-key';
    process.env.SUMMARY_PROVIDER = 'deepseek';

    expect(readyProfile(resolveSummaryProvider()).id).toBe('deepseek');
  });

  it('reports the missing variable for an explicit provider instead of spending the other balance', () => {
    process.env.OPENAI_API_KEY = 'sk-key';
    process.env.SUMMARY_PROVIDER = 'deepseek';

    const resolution = resolveSummaryProvider();

    expect(resolution.status).toBe('unconfigured');
    expect(resolution.status === 'unconfigured' && resolution.message).toContain('DEEPSEEK_API_KEY');
    expect(resolution.status === 'unconfigured' && resolution.message).not.toContain('OPENAI_API_KEY');
  });

  it('reports the missing OpenAI key when that provider is pinned', () => {
    process.env.DEEPSEEK_API_KEY = 'ds-key';
    process.env.SUMMARY_PROVIDER = 'openai';

    const resolution = resolveSummaryProvider();

    expect(resolution.status === 'unconfigured' && resolution.message).toContain('OPENAI_API_KEY');
  });

  it('names both variables when no provider is configured at all', () => {
    const resolution = resolveSummaryProvider();

    expect(resolution.status).toBe('unconfigured');
    const message = resolution.status === 'unconfigured' ? resolution.message : '';
    expect(message).toContain('OPENAI_API_KEY');
    expect(message).toContain('DEEPSEEK_API_KEY');
  });

  it('reads DEEPSEEK_MODEL and DEEPSEEK_BASE_URL per call', () => {
    process.env.DEEPSEEK_API_KEY = 'ds-key';
    process.env.DEEPSEEK_MODEL = 'deepseek-v4-pro';
    process.env.DEEPSEEK_BASE_URL = 'http://127.0.0.1:9/v1';

    const profile = readyProfile(resolveSummaryProvider());

    expect(profile.models.map((model) => model.name)).toEqual(['deepseek-v4-pro']);
    expect(profile.baseUrl).toBe('http://127.0.0.1:9/v1');

    delete process.env.DEEPSEEK_MODEL;
    delete process.env.DEEPSEEK_BASE_URL;
    const backToDefaults = readyProfile(resolveSummaryProvider());
    expect(backToDefaults.models[0]?.name).toBe(DEEPSEEK_DEFAULT_MODEL);
    expect(backToDefaults.baseUrl).toBe(DEEPSEEK_DEFAULT_BASE_URL);
  });

  it('prices a model by its own rate, with the Flash rate as the fallback', () => {
    process.env.DEEPSEEK_API_KEY = 'ds-key';

    const flash = readyProfile(resolveSummaryProvider()).models[0];
    process.env.DEEPSEEK_MODEL = 'deepseek-v4-pro';
    const pro = readyProfile(resolveSummaryProvider()).models[0];

    expect(flash?.prices).toEqual([0.15, 0.6]);
    expect(pro?.prices).toEqual([0.66, 1.98]);
  });

  it('keeps an unknown model name usable at the Flash rate', () => {
    process.env.DEEPSEEK_API_KEY = 'ds-key';
    process.env.DEEPSEEK_MODEL = 'deepseek-something-new';

    expect(readyProfile(resolveSummaryProvider()).models[0]?.prices).toEqual([0.15, 0.6]);
  });

  it('lets OPENAI_BASE_URL move the OpenAI endpoint, which the mock server relies on', () => {
    process.env.OPENAI_API_KEY = 'sk-key';
    process.env.OPENAI_BASE_URL = 'http://127.0.0.1:9/v1';

    expect(readyProfile(resolveSummaryProvider()).baseUrl).toBe('http://127.0.0.1:9/v1');
  });
});

describe('parseDeepSeekModel', () => {
  it('falls back to the default model with thinking off', () => {
    expect(parseDeepSeekModel(undefined)).toEqual({ name: DEEPSEEK_DEFAULT_MODEL, effort: undefined });
    expect(parseDeepSeekModel('   ')).toEqual({ name: DEEPSEEK_DEFAULT_MODEL, effort: undefined });
  });

  it('reads a bare model name as thinking off', () => {
    expect(parseDeepSeekModel('deepseek-v4-pro')).toEqual({ name: 'deepseek-v4-pro', effort: undefined });
  });

  it('splits `name:effort` on the last colon, tolerating spaces', () => {
    expect(parseDeepSeekModel('deepseek-v4-pro:high')).toEqual({ name: 'deepseek-v4-pro', effort: 'high' });
    expect(parseDeepSeekModel(' deepseek-flash : max ')).toEqual({ name: 'deepseek-flash', effort: 'max' });
    expect(parseDeepSeekModel('deepseek-flash:HIGH')).toEqual({ name: 'deepseek-flash', effort: 'high' });
  });

  it('accepts every effort word the API documents', () => {
    for (const effort of ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const) {
      expect(parseDeepSeekModel(`deepseek-flash:${effort}`)).toEqual({ name: 'deepseek-flash', effort });
    }
  });

  it('keeps a colon that is not an effort word inside the model name, for gateways', () => {
    // A self-hosted endpoint may serve Ollama-style tags; `qwen3:32b` is a model
    // name, not a model with 32b of effort.
    expect(parseDeepSeekModel('qwen3:32b')).toEqual({ name: 'qwen3:32b', effort: undefined });
    expect(parseDeepSeekModel('deepseek-flash:fast')).toEqual({ name: 'deepseek-flash:fast', effort: undefined });
    expect(parseDeepSeekModel(':high')).toEqual({ name: ':high', effort: undefined });
  });
});
