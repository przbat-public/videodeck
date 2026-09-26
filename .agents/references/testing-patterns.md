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

Assert by i18n key in client tests (`i18n.t('video.description')`), never by
the English or Polish literal a catalog happens to hold today.

## Waiting

Take the highest rung of the timing ladder that can express the fact:

```ts
// 1. A signal the app emits: the route it reports, the request the fake
//    logged, the row it re-rendered. Journeys live here.
await waitFor(() => {
  expect(page.router.state.location.pathname).toBe('/video/deepE2e0002');
  expect(screen.queryByLabelText('Fraza wyszukiwania')).toBeNull();
});

// 2. A poll with a budget, for a side effect with no signal of its own.
await waitFor(() => expect(within(section).queryAllByText('Pobrano')).toHaveLength(2), { timeout: 30_000 });

// 3. A fake clock instead of a real delay. The debounce constant comes from
//    the component, so the number cannot drift.
vi.useFakeTimers();
try {
  fireEvent.change(input(), { target: { value: 'dr' } });
  await act(async () => {
    vi.advanceTimersByTime(DEBOUNCE_DELAY + 1);
  });
} finally {
  vi.useRealTimers();
}
```

Budgets are named constants, and a fake never encodes a timing assumption
about its consumer. Two traps: `userEvent` deadlocks under fake timers (use
`fireEvent`, or fake only the window around the advance), and a zero-delay
interval spins the fake clock, so keep the timers under test positive when a
test advances past them.

## Locators after an interaction

The assertion has to distinguish the new page from the old one. In jsdom a
bare role plus name does not:

```ts
// The card renders the title as an <h3>, so this passes before the click
// navigates and proves nothing about the detail page.
await page.user.click(screen.getByRole('link', { name: /Historia kosmosu/ }));
await screen.findByRole('heading', { name: 'Historia kosmosu' });

// A state only the detail page has: its route, its back link, the list gone.
await waitFor(() => {
  expect(page.router.state.location.pathname).toBe('/video/deepE2e0002');
  expect(screen.getByRole('link', { name: /Wróć do listy/ })).toBeInTheDocument();
  expect(screen.queryByLabelText('Fraza wyszukiwania')).toBeNull();
});
```

The same rule kills `expect(await screen.queryByText('x')).toBeDefined()`,
which passes for `null`. `scripts/check-test-hygiene.mjs` (part of
`pnpm run lint`) fails both shapes before they land.

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
- Mock at a boundary you do not own where you can; a mocked app module gets a
  comment naming the behavior that hides.
- jest-dom 7 has no computed-style assertions; assert attributes or text
  the component renders.

## Fakes at the boundaries

The repo fakes external systems, never its own code:

- Fake Elasticsearch (`test-infra/src/fakeElasticsearch.ts`): wire-level
  responses including the `x-elastic-product` header and NDJSON bulk, plus the
  semantics the service leans on (asciifolding, `index.max_result_window`,
  the bulk `errors` flag), each named in its fidelity header.
- Mock OpenAI (`test-infra/src/mockOpenai.ts`): per-model responses and
  rate-limit behavior via `OPENAI_BASE_URL`.
- Fake yt-dlp (`scripts/fake-bin/yt-dlp`): writes the video plus sidecars
  and archive entries, wired through `YTDLP_PATH`.

Add a new fake when a new external boundary appears. Every fake carries a
fidelity note (what it models, what it leaves to the real dependency), its own
tests over its own surface (`server/src/test/fakeElasticsearch.test.ts`), and
a real-dependency twin in CI (`RUN_ES_INTEGRATION=1` against a real cluster)
so it cannot drift unnoticed.

Mocking an app module instead is a last resort, and the test says which
behavior that hides:

```ts
// Mocks the index writer: this test is about the retry count, not the write.
jest.mock('./videoScanner', () => ({ indexVideosFromDisk: jest.fn() }));
```

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
| Flaky timing waits | Named budgets, fake timers, awaited signals |
| Mocking the app's own modules | Mock only external boundaries, and say what the mock hides |
| Huge snapshots | Assert the specific text or attribute |
| Tests passing alone but failing together | Isolate state per test |
| An assertion that passes before the interaction | Assert a state only the new page has |
| A test that needs the previous test | Seed its own fixture folder and queue state, restore in `finally` |
| A fake that waits for its consumer | The fake answers; the test advances the clock |

## Prove-It for an assertion

Every new assertion gets the same treatment as a bug fix, before it counts:

1. Name the production line the assertion covers.
2. Mutate it (drop the click, the retry, the guard, the clamp).
3. Run the focused command: the assertion you wrote must be the one that
   fails, and the failure message has to name the missing behavior.
4. Restore, re-run green, report what was mutated and what the failure said.
