# Channel filter grouped by category

## Objective

The channel select on the video list stops carrying every one-off name the
`pojedyncze` collection has ever downloaded. It offers the channels behind the
configured folders, grouped under the category each of them declares. Measured
on the maintainer's own library: 99 entries become 20, in one section today and
two once the christianity folders are indexed.

## Non-goals

- The category select and the search itself do not change. `?channel=X` still
  filters by the exact indexed name, including a name the select does not
  offer, so a bookmarked link keeps working.
- Collections (`kind: "collection"`) stay searchable by text and by the
  category filter. They only stop feeding the channel select.
- No new endpoint. `GET /api/videos/channels` gains one field.
- No folding, no search box and no reordering inside the dropdown. Radix
  Select groups are enough.
- `chrome-extension/` is untouched.

## Decisions already made

- A channel name enters the select only when some configured folder of kind
  `channel` carries it in its indexed documents. Names that appear only in a
  collection folder (`pojedyncze`) are dropped from the select and stay
  filterable through the URL.
- The group header is the category string from `config.json`, verbatim. No
  renaming, no translation, no sorting other than `localeCompare`.
- A folder that declares no category keeps its channel under the `Bez
  kategorii` header rather than vanishing with the one-off names, because
  hiding a real channel costs more than one extra header. No folder in
  this library needs that section any more: every configured folder declares a
  category, and `electronics-gary-explains` was given `electronics` through
  `PUT /api/folder/config`. The section stays as the answer to a fresh folder
  or an unmounted drive.
- The category cache in `folderConfig` grows to carry the folder kind, so the
  join costs no extra disk read.

## Commands

```bash
pnpm run dev                                   # server :3001 + client :3000
cd server && pnpm run test                     # focused: -t "pattern"
cd client && pnpm run test:run                 # focused: -t "pattern"
pnpm run test:integration
cd client && pnpm run test:e2e
pnpm run verify                                # the full gate before the PR
```

## Structure

| workspace | change |
| --- | --- |
| `shared/` | `ChannelsResponseSchema` gains `channelCategories` |
| `server/` | the folder aggregation reads the mapped field; `listChannelsByFolder` returns the names per folder; `folderConfig` exposes the folders that stand for a channel; the channels route joins the two |
| `client/` | `ui/Select` renders option groups, `utils/channelGroups.ts` builds them, `SearchBar` and `useChannelNames` pass them through, pl and en catalogs |
| `test-infra/` | the fake Elasticsearch resolves `.keyword` and `.text` subfields from the index mapping instead of stripping the suffix |
| `chrome-extension/` | untouched |

## Contract

`GET /api/videos/channels`, all three fields in `ChannelsResponseSchema`:

- `channels`: same shape. Now it lists only what the folders of kind `channel`
  hold.
- `folders`: same shape, filled at last. The aggregation reads `folderPath`,
  which the mapping declares as `keyword`; it used to ask for
  `folderPath.keyword`, a field that does not exist, so the map came back
  empty and the console's "Szukaj w tym kanale" link never rendered. A folder
  that appears under several names keeps its most frequent one.
- `channelCategories`: new, channel name to that folder's category. A channel
  whose folder declares no category is absent from the map and still present
  in `channels`.

`listChannelsByFolder` returns `folders` as folder path to the names found
there, ordered by how many videos carry each. The route takes the first name
for the response's `folders` field and every name for the classification.

i18n, both catalogs in this change:

| key | pl | en |
| --- | --- | --- |
| `search.uncategorizedChannels` | Bez kategorii | Uncategorized |

## Style

Biome strict and strict TS as everywhere. No new dependency: Radix Select
2.3.7 already ships `Group` and `Label`, so `ui/Select` grows an optional
`groups` prop instead of a second dropdown implementation. `shared/` stays a
leaf. Feature logic lives in `client/src/utils/channelGroups.ts`; the component
only maps the helper's output to labels.

## Testing

One named test per acceptance criterion, RED first.

1. The aggregation reads the field the index maps:
   `server/src/services/elasticsearchService.test.ts`, "lists every channel name
   each folder carries, most frequent first".
2. A folder maps to every name its documents carry:
   `server/src/services/elasticsearchService.test.ts`, the same test, which
   pins the request's aggregation body as well.
3. Names that only a collection folder carries are dropped:
   `server/src/routes/videos.test.ts`, "drops names that no channel folder
   carries".
4. Channels carry the category of their folder:
   `server/src/routes/videos.test.ts`, "reports the category of every channel a
   channel folder holds".
5. A channel folder without a category stays in the list, ungrouped:
   `server/src/routes/videos.test.ts`, "keeps a channel folder that declares no
   category".
6. The real cluster answers the aggregation, which is what the mock cannot say:
   `server/src/services/elasticsearch.integration.test.ts`, "lists the channel
   of each folder through the field the mapping declares"
   (`RUN_ES_INTEGRATION=1`, runs in CI against the service container).
7. The test double refuses an unmapped subfield:
   `server/src/test/fakeElasticsearch.test.ts`, "buckets a terms aggregation
   only on a field the index mapping declares".
8. The select renders a header per group and reports a pick from inside one:
   `client/src/components/ui/Select.test.tsx`, "renders one named section per
   group and reports a pick from inside one".
9. The helper sorts groups and channels and puts the uncategorized last:
   `client/src/utils/channelGroups.test.ts`, "keeps the channels whose folder
   declares no category in the last section".
10. The search bar offers the groups and still shows a channel that only the URL
    names: `client/src/components/SearchBar.test.tsx`, "groups the channel
    options by category, without a header for the rest" and "keeps a channel
    that only the URL names, among the uncategorized ones".

The integration layer carries the cross-package story: the real `<App />`
against the real backend and the fake Elasticsearch, in
`client/src/__tests__/integration/search.journey.integration.test.tsx`,
"groups the channel filter by category and leaves single downloads out of it".

## Boundaries and risks

- Security invariants untouched. No new outbound fetch, no new yt-dlp argument,
  no user input reaching a filesystem path.
- Narrowing `channels` changes what the select can filter by. A collection's
  videos stay reachable by text search and by category, and a bookmarked
  `?channel=` link still filters and still displays its value.
- The fake change is the one with blast radius. Suites that aggregate on a
  subfield the mapping does not declare will fail, and that failure is real: it
  gets fixed at the call site, never by loosening the fake.
- Category reads touch an external disk. The 5 second cache absorbs a burst of
  search-as-you-type requests, and the join reuses the same snapshot.
- An unmounted drive has no `config.json` to read, so its channels carry no
  category and land under `Bez kategorii` until it comes back. The library
  stream drops the category cache when folders change, so the next read picks
  the drive up.

## Outcome

`shared/schemas.ts` carries `channelCategories`, the aggregation reads
`folderPath`, `listChannelsByFolder` replaces `listChannelNames`, and
`folderConfig.listChannelFolders` feeds the join. `ui/Select` renders groups,
`client/src/utils/channelGroups.ts` sorts them, and both catalogs carry
`search.uncategorizedChannels`. On the maintainer's library the picker went
from 99 names to 20, all of them inside one section.

Each new assertion was watched failing first. The aggregation reverted to
`folderPath.keyword` emptied the map in the unit test and against the real
cluster, the route without its collection filter offered a one-off name again
in the journey, the select without groups lost every option query, and the
helper without its rank put the uncategorized block first.
