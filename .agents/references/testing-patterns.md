# Testing Patterns Reference (videodeck)

> Adapted from [addyosmani/agent-skills](https://github.com/addyosmani/agent-skills) (MIT), rewritten for videodeck conventions.

Concrete patterns for the repo's four test layers. Read this when
`test-driven-development` needs a syntax example.

## Arrange, act, assert

Three visible blocks. Comments are optional; the blank lines carry the
structure.

```ts
it('rejects a folder outside the videos root', async () => {
  // Arrange
  const outside = path.join(tmp, 'elsewhere');

  // Act
  const res = await request(app).post('/api/folder/queue').send({ folderPath: outside });

  // Assert
  expect(res.status).toBe(403);
});
```

## Naming

`describe` names the unit, `it` names the observable behavior. Reader
understands the contract without opening the code:

- `it('returns 401 when the API token is missing')`
- `it('marks finished downloads locally and re-syncs when the queue drains')`

Assert by i18n key in client tests (`getByRole('button', { name: 'search.submit' })`),
never by Polish literals.

## Server patterns (jest + supertest)

- Boot the app with `deepServerTestEnv` from `@videodeck/test-infra` so the
  fake Elasticsearch, mock OpenAI and fake yt-dlp serve real responses.
- Assert status, body shape (parsed with zod schemas from
  `shared/schemas.ts`) and side effects (files written, queue state).
- Time control with `jest.useFakeTimers()`; no `setTimeout` waits.

## Client patterns (vitest + React Testing Library)

- Render the real component; prefer `getByRole` queries.
- Wrap state updates in `act` via `fireEvent` or `userEvent`; the `act(...)`
  console warnings in existing suites are noise, not failures.
- Mock the module boundary, not the internals: `vi.mock('../api')` style,
  and assert on rendered outcome.
- jest-dom 7 has no computed-style assertions; assert attributes or text
  the component renders.

## Fakes at the boundaries

The repo fakes external systems, never its own code:

- Fake Elasticsearch (`test-infra/src/fakeElasticsearch.ts`): wire-level
  responses including the `x-elastic-product` header and NDJSON bulk.
- Mock OpenAI (`test-infra/src/mockOpenai.ts`): per-model responses and
  rate-limit behavior via `OPENAI_BASE_URL`.
- Fake yt-dlp (`scripts/fake-bin/yt-dlp`): writes the video plus sidecars
  and archive entries, wired through `YTDLP_PATH`.

Add a new fake when a new external boundary appears. Keep fakes minimal:
enough behavior for the test, no more.

## Integration and e2e

- In-process client integration (`pnpm run test:integration`): the real
  `<App />` against the real backend; the only patch is a fetch rewrite to
  the in-process base URL.
- Playwright (`cd client && pnpm run test:e2e`): the thin browser layer
  with a mocked API. New user flows get one e2e test; deep logic stays in
  the integration layer.

## Anti-patterns

| Anti-pattern | Fix |
| --- | --- |
| Testing implementation details | Assert inputs and outputs |
| Flaky timing waits | Fake timers, awaited promises |
| Mocking the app's own modules | Mock only external boundaries |
| Huge snapshots | Assert the specific text or attribute |
| Tests passing alone but failing together | Isolate state per test |
