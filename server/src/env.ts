import { z } from 'zod';

/**
 * Startup validation of the environment (zod — parse, don't trust).
 *
 * config.ts still reads `process.env` lazily (tests set/clear values per
 * case), but a real boot goes through `validateEnv` first: a typo like
 * `POR=3001` or `VIDEOS_FOLDER_PAT=/x` fails fast with every problem listed,
 * instead of the server limping along with a wrong port or no folders.
 */

const positiveInt = (name: string) =>
  z.coerce.number().int().positive().optional().describe(`${name} must be a positive integer`);

const EnvSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  HOST: z.string().min(1).default('127.0.0.1'),
  VIDEOS_FOLDER_PATH: z.string().min(1, 'VIDEOS_FOLDER_PATH must not be empty'),
  ELASTICSEARCH_URL: z.string().url().default('http://localhost:9200'),
  API_TOKEN: z.string().optional(),
  REQUIRE_API_TOKEN: z
    .enum(['true', 'false'])
    .optional()
    .describe('Set to true to refuse all requests when API_TOKEN is not configured'),
  CORS_ORIGINS: z.string().optional(),
  ALLOWED_HOSTS: z.string().optional(),
  EXTENSION_ORIGINS: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  DOWNLOAD_CONCURRENCY: positiveInt('DOWNLOAD_CONCURRENCY'),
  UPDATE_CONCURRENCY: positiveInt('UPDATE_CONCURRENCY'),
  DOWNLOAD_MAX_ATTEMPTS: positiveInt('DOWNLOAD_MAX_ATTEMPTS'),
  RATE_LIMIT_MAX: positiveInt('RATE_LIMIT_MAX'),
  RATE_LIMIT_WINDOW_MS: positiveInt('RATE_LIMIT_WINDOW_MS'),
  LOG_LEVEL: z.enum(['info', 'warn', 'error', 'silent']).optional(),
});

export type ValidatedEnv = z.infer<typeof EnvSchema>;

/**
 * Validate `process.env` for a real boot. Throws one Error whose message
 * lists every invalid variable, or returns the parsed (defaulted) values.
 */
export function validateEnv(env: NodeJS.ProcessEnv): ValidatedEnv {
  const result = EnvSchema.safeParse(env);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid environment configuration: ${issues}`);
  }
  return result.data;
}
