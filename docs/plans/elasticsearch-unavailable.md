# When Elasticsearch is not available

## Objective

Today a stopped Elasticsearch prints a multi-level stack for every request that
touches it, answers `500 Internal server error`, and takes the whole status page
down with it, because `GET /api/status` awaits an Elasticsearch call it could do
without. After this lands, the server recognises an unreachable Elasticsearch,
answers `503` with a machine-readable code, logs one compact line per window
instead of a stack per request, keeps the disk-backed parts of the app working,
and the client shows one banner that says what is broken and what still works.

Measured before: one status page load with Elasticsearch down produces three
stack traces in the terminal (`/api/status`, `/api/videos/channels`,
`/api/folder/summaries` is disk-only so two, plus `/health` when the extension
polls it), the console renders nothing, and the only clue in the UI is
"Błąd: Nie udało się pobrać statusu".

## Non-goals

- No offline mode. Search, indexing and anything that reads documents stay
  unavailable while Elasticsearch is down.
- No retry queue for failed searches, no caching of search results.
- No automatic restart of the Elasticsearch container or any Docker coupling.
- No change to the search contract beyond the status code and the error code.
- No new dependencies.

## Decisions already made

- Detection reuses what exists: `GET /health` already probes Elasticsearch
  (`checkElasticsearchConnection`, 5 s cache) and the browser extension already
  uses it. The UI gets the same signal instead of a second health concept.
- A connection failure is a dependency failure, so it answers `503` with
  `{ error, code: 'elasticsearch_unavailable' }`. `ApiErrorSchema` gains an
  optional `code`, also for the client to translate.
- The terminal keeps the full stack for unexpected errors. Only the connection
  failure is reduced, and at most once per 30 s window, because it repeats on
  every request and every health poll.
- `GET /api/status` stops depending on Elasticsearch: the folder list, configs
  and `list.json` presence come from disk. The response grows
  `elasticsearch: 'ok' | 'down'`, and the index chips are suppressed while it is
  down, because a chip per channel would say "reindex everything" when the
  truth is "the index cannot be read right now".
- Fail-fast (PR3) is a short window (5 s) with the health probe exempt, so
  recovery is detected by the same poll the banner already runs.

## Structure

- `server/src/services/elasticsearchErrors.ts`: `isElasticsearchUnavailable`
  (walks the `cause` chain for `ConnectionError`, `NoLivingConnectionsError`,
  `TimeoutError`, socket codes and `ResponseError` with status 503) and
  `ElasticsearchUnavailableError`.
- `server/src/app.ts`: `errorHandler` maps it to `503`, logs one compact line
  through a small rate limiter; the startup log pings once.
- `server/src/services/elasticsearchService.ts`: `checkElasticsearchConnection`
  logs one line, gains the breaker state and sets the `elasticsearch_up` gauge.
- `server/src/routes/folder.ts`: the status handler tolerates a failed
  `listCachedFolders`.
- `shared/schemas.ts`: `StatusResponseSchema.elasticsearch`, `ApiErrorSchema.code`.
- `client/src/hooks/useServerHealth.ts`, `client/src/components/AppLayout.tsx`
  (banner), `client/src/utils/elasticsearchStatus.ts` (a tiny store so a failed
  request can report it immediately, not only on the next poll),
  `client/src/components/appMenuRegistry.ts` (index actions disabled),
  `client/src/i18n/locales/{pl,en}.json`.
- `test-infra/src/fakeElasticsearch.ts`: `restart()` rebinding the same port, so
  an integration test can take Elasticsearch away and give it back.

## Contract

- `GET /health` keeps its shape (`{ status, elasticsearch }`) and its 200/503.
- New: `ApiErrorSchema` `code?: string`; the only code defined now is
  `elasticsearch_unavailable`.
- New: `StatusResponseSchema` `elasticsearch: 'ok' | 'down'`.
- New metric: `elasticsearch_up` gauge (1/0), refreshed by `/metrics` the same
  way `download_queue_size` is.
- New i18n keys: the banner (title, body, retry) and the Elasticsearch-specific
  error message, pl and en.

## Style

- Tokens and the shared primitives only: the banner is `ErrorMessage` plus a
  `Button`, no new component family.
- The banner is `role="status"` (it is a state, not a failure of the current
  action) and sits under the top bar, above the page content.
- Biome strictness, strict TS, dependency-cruiser boundaries unchanged.

## Testing

- Server unit (`elasticsearchErrors.test.ts`, `app.test.ts`): the classifier on
  a connection error, a wrapped cause, a socket code and an ES 503; the error
  handler answering 503 with the code; the rate limiter logging once for two
  failures inside the window; the full stack still logged for other errors.
- Server integration (`deepServer.integration.test.ts`): stop the fake
  Elasticsearch, then `/api/status` still answers with the folder list and
  `elasticsearch: 'down'`, `/api/videos/search` answers 503 with the code, and
  `/health` answers 503; restart it and everything answers normally again.
- Client integration (real `<App />`, real backend, fake external world): with
  Elasticsearch stopped, the download console still renders its rows, the banner
  appears, the search page shows the Elasticsearch message instead of a generic
  one; after the restart the banner's retry clears it and a search returns
  results. The index menu entries are disabled while it is down.
- Client unit: the health hook (poll, focus, retry, store reporting) and the
  banner rendering.
- E2E (mocked API): `/health` answering 503 shows the banner, the retry hides it
  once the mock answers 200 again, and the index actions are disabled.

## Boundaries and risks

- The error handler must not swallow real bugs: only classified connection
  failures take the compact path, everything else keeps the stack and the 500.
- The rate limiter is process-wide state; a single-flight window is enough for
  one self-hosted server, and the tests assert two failures produce one line.
- Suppressing the index chips while Elasticsearch is down can hide a channel
  that really is not indexed. The banner carries that state, and the chips come
  back with the next successful status read.
- The breaker can delay a recovery by up to its window. The health poll runs
  every 5 s and is exempt, so the delay is bounded and visible.
