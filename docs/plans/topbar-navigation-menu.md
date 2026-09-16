# Top bar navigation and application menu

## Objective

After this lands, the whole app is reachable from one global top bar: the
brand on the left (clicking it goes to the film list), a back button on the
detail page, and a gear menu on the right holding the download page link,
the index actions, the theme and the language. The film list becomes the
home route `/` and the download/status page moves to `/download`.

## Non-goals

- No server, API contract, queue or extension changes.
- No restyling beyond the top bar and the removed toolbar.
- No animations beyond the existing transition contract.
- Per-folder rebuild buttons on the download page stay where they are.
- Search behavior and URL state handling stay unchanged.

## Decisions already made

- `/` = film list, `/download` = status page, `/video/:videoId` unchanged.
- The old `/videos` route is deleted with no redirect; old links land on
  the existing RouteError page.
- Right side: one gear icon opening a single menu, on every page.
- Left side: brand/name (link to the list) plus a back button on the detail
  page only.
- Menu contents: download page link, index actions (list page only),
  theme and language as flat checked items.
- The list toolbar is removed entirely, including the video counter.
- The "Odśwież" (reload results) action moves into the menu as a list-page
  item ("Odśwież wyniki"); it re-runs the search with the current URL
  state, as the toolbar button did.
- The "Przejdź do listy filmów" button on the download page is removed;
  the brand link covers that navigation.
- New dependency `@radix-ui/react-dropdown-menu` and a new `ui/Menu`
  primitive, documented in DESIGN.md.

## Structure

- `client/` only. New `components/ui/Menu.tsx` (Radix DropdownMenu behind
  our props, like Select), a composite `components/AppMenu.tsx` (sections,
  theme and language items, index actions, progress states), and the top
  bar assembled in `App.tsx`.
- `routes.tsx` swaps the two pages and drops `/videos`.
- `VideoListPage.tsx` loses the toolbar; its reindex hooks move into
  `AppMenu` (visible on the list route only).
- `App.css` styles for the menu items, the top bar split layout and the
  44px touch targets; `index.css` unchanged.
- Docs: README quickstart wording (status page and refresh index now live
  behind the menu), DESIGN.md primitive list.

## Contract

- No `shared/schemas.ts` changes.
- i18n keys in `pl.json` and `en.json` in the same change: menu button
  label, section headers, download item, back-to-list label, refresh
  results item. Existing `reindex.*` and `theme.*` keys are reused.
- Menu accessibility follows the APG menu button pattern, which Radix
  provides: `aria-haspopup`, `aria-expanded`, `role=menu`, full keyboard
  support, typeahead, focus return.

## Style

- Tokens only, both themes, sentence case, no em dashes in `.agents/`,
  Biome strictness and the type-aware ESLint rules unchanged.
- The menu item styling mirrors `.ui-select-content` and
  `.ui-select-item` so the dropdowns look like one family.
- The gear button keeps a 44px touch floor on narrow screens.

## Testing

- Unit: `ui/Menu.test.tsx` (opens, checks an item, keyboard interaction)
  and `AppMenu.test.tsx` (sections render, index items hidden outside the
  list route, theme and language pick through the menu).
- Integration: route swap in the existing journey suites (memory router
  already shares `routes.tsx`): "the film list renders at / and the
  download page at /download", "an unknown /videos path shows RouteError",
  "the detail page back button returns to the list".
- E2E: update the 14 `goto('/videos')` calls to `/` or `/download` as
  appropriate; new spec assertions: gear menu opens and navigates to the
  download page, index section absent there, top bar still never overlaps
  content and keeps 44px targets.
- The toolbar removal is covered by "the list page renders no toolbar
  buttons and the video counter is gone".

## Boundaries and risks

- No cross-app imports, no new server endpoints.
- Old bookmarks to `/videos` break by design (accepted).
- The e2e and integration suites hardcode `/videos`; the churn is
  mechanical but must stay green before merge.
- The new dependency is reviewed as part of the PR (Radix family already
  in use for Select).
