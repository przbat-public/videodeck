# Pluggable summary providers: OpenAI and DeepSeek

## Objective

After this lands, a self-hoster can run AI summaries on DeepSeek by adding
`DEEPSEEK_API_KEY` to `server/.env`, and choose the model and its reasoning
effort with one variable (`DEEPSEEK_MODEL=deepseek-v4-pro:high`). With only
`OPENAI_API_KEY` set nothing changes; with both keys set `SUMMARY_PROVIDER`
pins the choice. The pipeline around the call (disk cache, in-flight dedup, the
two-generation semaphore, the 429 fallback, the truncation marker, the cost
metrics) behaves exactly as it does today, because only the provider profile
changes.

## Non-goals

- No per-video or per-folder provider choice, no switch in the UI, no key
  handling in the browser or the extension.
- No streaming, no chat, no embeddings, no change to the summary response.
- No removal of the OpenAI path. DeepSeek is an alternative, not a replacement.
- No generic third-party base URL feature beyond what tests and self-hosted
  gateways need.
- No new dependency: DeepSeek speaks the OpenAI wire format, so `openai` stays
  the only SDK.

## Decisions already made

- The switch is automatic. `DEEPSEEK_API_KEY` present means DeepSeek, which is
  the one-line switch that was asked for. `SUMMARY_PROVIDER=openai|deepseek`
  overrides it in either direction, and an explicit provider whose key is
  missing answers the existing 503 instead of quietly spending the other
  balance.
- `API_TOKEN` stays out of it. It is the bearer token guarding `/api`, shared
  with the nginx container and the Chrome extension; an LLM key must not travel
  with it.
- Thinking mode is off for summary calls by default (`thinking: { type:
  'disabled' }`). DeepSeek enables it at high effort on its own, it ignores
  `temperature` while thinking, and summarizing a transcript needs no chain of
  thought. An operator who wants the reasoning can ask for it.
- Model names are configuration. `deepseek-chat` and `deepseek-reasoner` were
  retired on 2026-07-24, so the default is `deepseek-flash`.
- `DEEPSEEK_MODEL` carries the effort too: `name` or `name:effort`, where the
  effort is one of `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`.
  The suffix turns thinking on; `none` and a bare name mean off. Sending
  `reasoning_effort` while thinking is off would be an error, so the two fields
  always travel together. A suffix that is not an effort word stays part of the
  model name, which keeps gateway tags such as `qwen3:32b` usable, and a
  misspelled effort fails loudly at the provider instead of silently losing the
  suffix.
- Thinking spends output tokens on reasoning, so the output cap grows from 2000
  to 8000 when an effort is set. The `temperature` leaves the request in that
  mode for the same reason it is meaningless there.
- The DeepSeek input budget is 100k tokens against OpenAI's 25k. The model takes
  a 1M context, so long transcripts stop hitting the truncation marker; 25k
  tokens of input costs about $0.004 at the off-peak rate.
- Cost stays an estimate. DeepSeek bills peak and off-peak (a factor of two) and
  discounts cache hits, so the profile records off-peak prices and the metric
  carries a provider label.

## Structure

- `server/src/config.ts`: `getSummaryProvider()`, `getDeepSeekApiKey()`,
  `getDeepSeekModel()`, `getDeepSeekBaseUrl()`, all read lazily like the
  existing getters. The DeepSeek getters return raw values and the provider
  defaults live in `llmProviders`, so each default has one home.
- `server/src/env.ts`: the new variables in the zod schema.
- `server/src/services/llmProviders.ts` (new): one profile per provider (label,
  key, base URL, models, input budget, prices, output cap, sampling
  temperature, extra request fields), `parseDeepSeekModel()` for the
  `name:effort` value, and `resolveSummaryProvider()`.
- `server/src/services/summaryService.ts`: takes the resolved profile instead
  of calling `getOpenAiApiKey` and reading module constants. The helpers, the
  cache, the semaphore and the fallback loop stay as they are.
- `server/src/routes/videos/summary.ts`: the 503 message names both variables.
- `client/src/i18n/locales/pl.json` and `en.json`: `toast.summaryUnavailable`
  stops naming OpenAI alone.
- `README.md`, `docs/README.pl.md`, `docs/INSTALL.md`, `docs/DEPLOYMENT.md`,
  `docs/API.md` (metric names), `server/.env.example`, `docker-compose.yml`,
  `CHANGELOG.md`.
- `test-infra/src/deepServerTestEnv.ts`: point DeepSeek at the same in-process
  mock the OpenAI path uses.

## Contract

- `shared/schemas.ts` does not change. The summary response stays
  `{ summary, truncated? }` and the 503 keeps its shape.
- New server variables, all optional: `SUMMARY_PROVIDER` (`openai` or
  `deepseek`), `DEEPSEEK_API_KEY`, `DEEPSEEK_MODEL` (a model name or
  `name:effort`, default `deepseek-flash` with thinking off), `DEEPSEEK_BASE_URL`
  (default `https://api.deepseek.com`).
- The DeepSeek chain holds one model, so a 429 fails fast with the message that
  already exists for an exhausted chain. A second name can join the list later.
- Metrics are renamed with a `provider` label:
  `openai_summary_requests_total` becomes `summary_requests_total`, and the
  same for the tokens and cost counters. No alias is kept, and the CHANGELOG
  says so in one line, because a stale Grafana query would otherwise read zero
  for ever.
- One i18n value changes in each catalog; no key is added.

## Style

- Biome strictness and strict TS. The DeepSeek-only request field goes through a
  typed request body rather than a cast on data from the network.
- No new dependency, and the `dependency-cruiser` boundaries do not move: the
  new module is server-only.

## Testing

- `llmProviders.test.ts` (new): DeepSeek key alone selects DeepSeek; OpenAI key
  alone selects OpenAI; `SUMMARY_PROVIDER=openai` wins over a DeepSeek key; an
  explicit provider without its key resolves to unavailable; the default base
  URL and the model default; `parseDeepSeekModel` on every documented effort
  word, on `none`, on a bare name, on surrounding spaces and on a colon that is
  not an effort (`qwen3:32b`); the profile a suffixed value produces (thinking
  on, effort sent, no temperature, a higher output cap, prices from the bare
  name).
- `config.test.ts` and `env.test.ts`: the new getters and the schema entries.
- `summaryService.test.ts`: the client is built with the DeepSeek base URL and a
  disabled thinking flag; the model list comes from `DEEPSEEK_MODEL`; the body
  carries the effort and drops the temperature when one is configured; a missing
  key throws `SummaryUnavailableError` naming `DEEPSEEK_API_KEY`.
- `videos.test.ts`: the 503 body names both variables.
- `deepServer.integration.test.ts`: with the DeepSeek provider selected and the
  base URL on the in-process mock, a real request writes the summary file and
  the mock saw the DeepSeek model, with and without an effort.
- `useVideoSummary.test.ts`: the changed unavailable string.
- The Playwright layer does not change; it mocks the API.

## Boundaries and risks

- The OpenAI SDK picks up `OPENAI_BASE_URL` from the environment by itself.
  DeepSeek gets an explicit `baseURL`, so a stray variable cannot redirect it.
- `DEEPSEEK_BASE_URL` is operator-set, never user input, and validated as a URL
  at boot, so it does not reopen the SSRF surface.
- Renaming the metrics breaks dashboards that match the old names. Accepted, and
  recorded in the CHANGELOG.
- The provider is resolved per call from the environment, so a test or a
  restarted container can switch without a code path that caches a stale client.
