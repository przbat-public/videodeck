import {
  getDeepSeekApiKey,
  getDeepSeekBaseUrl,
  getDeepSeekModel,
  getOpenAiApiKey,
  getOpenAiBaseUrl,
  getSummaryProviderOverride,
} from '../config';

/**
 * The provider a summary request runs on.
 *
 * Everything the pipeline needs sits in one profile: the endpoint, the models
 * to try in order, how much input each accepts, what a token costs and which
 * provider-only fields the request body carries. The disk cache, the
 * semaphore, the 429 walk and the cost metric read this profile, so a new
 * provider is a data change rather than a second copy of the pipeline.
 */

export type SummaryProviderId = 'openai' | 'deepseek';

/** One model of a provider's fallback chain */
export interface SummaryModelProfile {
  /** Model name exactly as the provider expects it */
  readonly name: string;
  /** Largest input the model may receive; longer text is truncated to fit */
  readonly inputBudget: number;
  /** Approximate USD per 1M tokens, [input, output], for the cost estimate */
  readonly prices: readonly [number, number];
  /** Output cap; reasoning models share it with their chain of thought */
  readonly maxTokens: number;
  /** Sampling temperature; omitted while thinking, which ignores it */
  readonly temperature?: number;
  /** Provider-only request fields */
  readonly extras?: SummaryRequestExtras;
}

/**
 * Provider-only request fields. DeepSeek reads `thinking` and
 * `reasoning_effort`; OpenAI's chat models read neither.
 */
export interface SummaryRequestExtras {
  thinking?: { type: 'enabled' | 'disabled' };
  reasoning_effort?: DeepSeekEffort;
}

export interface SummaryProviderProfile {
  id: SummaryProviderId;
  /** Credential, read per call so a test or a restarted container can switch */
  apiKey: string;
  /** undefined keeps the SDK's own endpoint */
  baseUrl: string | undefined;
  models: readonly SummaryModelProfile[];
}

export type SummaryProviderResolution =
  | { status: 'ready'; profile: SummaryProviderProfile }
  | { status: 'unconfigured'; message: string };

/**
 * OpenAI's chain, in order of preference. gpt-4 and gpt-4-turbo are retired by
 * OpenAI and their 8k context can never accept the 25k input budget, so the
 * fallback is gpt-4o then gpt-4o-mini, which takes the smaller budget.
 */
export const OPENAI_SUMMARY_MODELS: readonly SummaryModelProfile[] = [
  { name: 'gpt-4o', inputBudget: 25_000, prices: [2.5, 10], maxTokens: 2_000, temperature: 0.7 },
  { name: 'gpt-4o-mini', inputBudget: 8_000, prices: [0.15, 0.6], maxTokens: 2_000, temperature: 0.7 },
];

/** Current cheapest DeepSeek model; `DEEPSEEK_MODEL` replaces it */
export const DEEPSEEK_DEFAULT_MODEL = 'deepseek-flash';

export const DEEPSEEK_DEFAULT_BASE_URL = 'https://api.deepseek.com';

/**
 * The DeepSeek family takes a 1M-token context, so this budget is a cost guard
 * and not a limit: 100k tokens of input stays around $0.015 at the off-peak
 * rate, and long transcripts stop being truncated to 25k.
 */
export const DEEPSEEK_INPUT_BUDGET = 100_000;

/** Output cap without thinking: a summary of a transcript fits in a page */
const SUMMARY_MAX_OUTPUT_TOKENS = 2_000;

/** ...and with thinking, which spends part of the same budget on reasoning */
const THINKING_MAX_OUTPUT_TOKENS = 8_000;

/** Sampling temperature; DeepSeek ignores it while thinking is on */
const SUMMARY_TEMPERATURE = 0.7;

/**
 * Reasoning effort words DeepSeek documents. The API folds them into three
 * levels (`minimal`/`low` are low, `medium`/`high`/`xhigh` are high, `max` is
 * max), and `none` switches thinking off, which is also what a bare model name
 * means.
 */
const EFFORT_WORDS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

export type DeepSeekEffort = (typeof EFFORT_WORDS)[number];

/** What `DEEPSEEK_MODEL` says: which model, and how hard it should think */
export interface DeepSeekModelSetting {
  readonly name: string;
  /** undefined and 'none' both mean thinking off */
  readonly effort: DeepSeekEffort | undefined;
}

function isEffortWord(value: string): value is DeepSeekEffort {
  return EFFORT_WORDS.some((word) => word === value);
}

/**
 * Parse `DEEPSEEK_MODEL`: `name`, or `name:effort` where effort is one of the
 * words above. The suffix is matched against that list, so a self-hosted
 * endpoint serving Ollama-style tags (`qwen3:32b`) keeps its colon, and a
 * misspelled effort stays part of the model name rather than being silently
 * dropped.
 */
export function parseDeepSeekModel(value: string | undefined): DeepSeekModelSetting {
  const raw = (value ?? '').trim();
  if (raw.length === 0) {
    return { name: DEEPSEEK_DEFAULT_MODEL, effort: undefined };
  }

  const separator = raw.lastIndexOf(':');
  if (separator === -1) {
    return { name: raw, effort: undefined };
  }

  const name = raw.slice(0, separator).trim();
  const suffix = raw
    .slice(separator + 1)
    .trim()
    .toLowerCase();
  if (name.length === 0 || !isEffortWord(suffix)) {
    return { name: raw, effort: undefined };
  }
  return { name, effort: suffix };
}

/**
 * Off-peak DeepSeek prices in USD per 1M tokens, [input, output]. Peak hours
 * double them and cache hits cut the input price to a fraction, so the cost
 * metric stays an estimate. A model this table does not know is billed at the
 * Flash rate rather than as free.
 */
const DEEPSEEK_PRICES: Record<string, readonly [number, number]> = {
  'deepseek-flash': [0.15, 0.6],
  'deepseek-v4-pro': [0.66, 1.98],
};

const DEEPSEEK_FALLBACK_PRICES: readonly [number, number] = [0.15, 0.6];

function ready(profile: SummaryProviderProfile): SummaryProviderResolution {
  return { status: 'ready', profile };
}

function unconfigured(variable: string): SummaryProviderResolution {
  return { status: 'unconfigured', message: `${variable} environment variable is required` };
}

function openAiProfile(apiKey: string): SummaryProviderProfile {
  return {
    id: 'openai',
    apiKey,
    baseUrl: getOpenAiBaseUrl(),
    models: [...OPENAI_SUMMARY_MODELS],
  };
}

/** One DeepSeek model, configured with or without thinking */
function deepSeekModel(setting: DeepSeekModelSetting): SummaryModelProfile {
  const shared = {
    name: setting.name,
    inputBudget: DEEPSEEK_INPUT_BUDGET,
    prices: DEEPSEEK_PRICES[setting.name] ?? DEEPSEEK_FALLBACK_PRICES,
  };
  if (setting.effort === undefined || setting.effort === 'none') {
    // Thinking off: the model samples normally, so the temperature applies.
    return {
      ...shared,
      maxTokens: SUMMARY_MAX_OUTPUT_TOKENS,
      temperature: SUMMARY_TEMPERATURE,
      extras: { thinking: { type: 'disabled' } },
    };
  }
  return {
    ...shared,
    maxTokens: THINKING_MAX_OUTPUT_TOKENS,
    // Thinking ignores the sampling temperature and answers at its own effort.
    extras: { thinking: { type: 'enabled' }, reasoning_effort: setting.effort },
  };
}

function deepSeekProfile(apiKey: string): SummaryProviderProfile {
  return {
    id: 'deepseek',
    apiKey,
    baseUrl: getDeepSeekBaseUrl() ?? DEEPSEEK_DEFAULT_BASE_URL,
    models: [deepSeekModel(parseDeepSeekModel(getDeepSeekModel()))],
  };
}

/**
 * Which provider answers the next summary request.
 *
 * `SUMMARY_PROVIDER` wins when it is set, and a pinned provider whose key is
 * missing stays unconfigured instead of spending the other account. Without a
 * pin the key that is present decides, and DeepSeek wins when both are set,
 * because adding its key is the documented way to switch.
 */
export function resolveSummaryProvider(): SummaryProviderResolution {
  const override = getSummaryProviderOverride();
  const openAiKey = getOpenAiApiKey();
  const deepSeekKey = getDeepSeekApiKey();

  if (override === 'openai') {
    return openAiKey ? ready(openAiProfile(openAiKey)) : unconfigured('OPENAI_API_KEY');
  }
  if (override === 'deepseek') {
    return deepSeekKey ? ready(deepSeekProfile(deepSeekKey)) : unconfigured('DEEPSEEK_API_KEY');
  }

  if (deepSeekKey) {
    return ready(deepSeekProfile(deepSeekKey));
  }
  if (openAiKey) {
    return ready(openAiProfile(openAiKey));
  }
  return unconfigured('OPENAI_API_KEY or DEEPSEEK_API_KEY');
}
