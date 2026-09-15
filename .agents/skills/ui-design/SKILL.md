---
name: ui-design
description: videodeck UI design conventions. Reads DESIGN.md and enforces the token palette, the five shared primitives, dark-mode parity, WCAG 2.1 AA accessibility and i18n rules whenever UI changes. Use when editing React components, CSS, or adding user-visible text in this repository, or when asked to restyle, polish, audit, or redesign the client.
user-invocable: true
argument-hint: '"the change I plan" [--mode audit|guide|review]'
---

# videodeck UI design conventions

Before touching any UI code, read `DESIGN.md` at the repo root. It is the
contract: it lists the real tokens, the five shared primitives, the layout
rules and the copy rules. This skill turns that contract into a checklist.

## Modes

- `guide` (default): plan a UI change against the contract.
- `audit`: scan the client for contract violations and report them.
- `review`: check an existing change or PR against the checklist.

## Checklist

1. **Tokens only.** Every color comes from `client/src/index.css`. A
   hardcoded hex or `white`/`black` outside the allowed surfaces (header
   gradient, video player, white text on semantic buttons) is a violation.
   New colors mean new tokens in BOTH themes plus a `DESIGN.md` update.
2. **Both themes.** The change must read well under `:root` and
   `:root[data-theme='dark']`. Never add a light-only background or a
   dark-only text color.
3. **Primitives first.** Buttons use `ui/Button` variants, selects use
   `ui/Select`, errors use `ui/ErrorMessage`, spinners use `ui/Loading`,
   checkboxes use `ui/Checkbox`. Do not build a new ad-hoc button or
   spinner.
4. **Spacing rhythm.** Use the 0.25/0.5/1/2rem scale; 1rem between
   controls; cards get `--radius-card` and `--shadow-card`.
5. **Accessibility.** WCAG 2.1 AA is the bar. Every input gets an
   accessible name. Focus stays visible (`:focus-visible`). Text contrast
   at least 4.5:1, including white text on `--color-primary`. Error
   banners use `role="alert"`. The full checklist lives at
   `../../references/accessibility-checklist.md`.
6. **Motion.** Transitions only, 0.15-0.3s, and `prefers-reduced-motion`
   already collapses them. No entrance animations.
7. **Copy.** User-visible text goes into the i18n catalogs, pl and en in
   the same change, keys asserted by `locales.test.ts`. Imperative
   commands, short labels, no exclamation marks, no emoji.
8. **Tests.** Component behavior changes ship with tests; UI text is
   asserted by key or by the localized label the test locale renders.

## Component architecture

- **Boundaries.** A component does one job; composites in
  `client/src/components/` coordinate, primitives in `ui/` never know
  about pages, routes or API shapes. A shared module stays generic; keep
  feature logic in the page or hook that owns it.
- **State placement.** Server data lives in hooks under
  `client/src/hooks/` (`useVideoSearch`, `useDownloadQueue`,
  `useVideoDetail`). Reducer-shaped state lives in
  `client/src/reducers/`. Do not hoist state into a page just to pass it
  down; URL-backed state (search phrase, sort) stays in the URL via
  `searchUrlState`.
- **Lists.** The video list virtualizes with react-window; new long lists
  reuse it instead of rendering thousands of nodes. Keys are stable
  (`summary-${videoId}-${subtitlePath}`), never array indexes.
- **Responsive.** One real breakpoint exists, max-width 768px in
  `App.css`. New layouts collapse there; do not add a second system of
  breakpoints.
- **Errors.** Runtime errors fall through `ErrorBoundary`; expected
  failures use `ui/ErrorMessage`, toasts are additional signals, never
  the only one.

## Audit output format

For `--mode audit`, report one table:

| Area | Finding | Fix |
| --- | --- | --- |
| tokens | e.g. `background: #fafafa` in App.css | use `--color-bg-soft` |
| themes | e.g. hardcoded `#fff` on a card | `--color-surface` |
| primitives | e.g. custom button markup | `ui/Button` |
| a11y | e.g. input without a name | `aria-label` |
| copy | e.g. string in the component | i18n key + both catalogs |

Rank findings by user impact, not by file order. Skip false positives:
semantic button colors and the player background are deliberate (see
DESIGN.md section 2).

## Audit scorecard

Then score five dimensions 0-4 (0 broken, 4 meets the contract fully) and
total them out of 20:

| Dimension | What a 4 means |
| --- | --- |
| Tokens & themes | every color is a token, both themes hold, DESIGN.md updated |
| Hierarchy & spacing | one clear main path per screen, rhythm on the 0.25/0.5/1/2rem scale |
| Primitives & structure | ui/ primitives only, state placed where the rules say |
| Accessibility | the WCAG 2.1 AA checklist items pass for the touched surface |
| Copy & i18n | keys in both catalogs, imperative labels, no exclamation marks |

Judge the dimensions through two lenses: Nielsen's heuristics (status
visibility, error prevention, consistency and standards) and the classic
design laws (Fitts: targets easy to reach; Hick: short option lists;
proximity: related controls together). Then walk one persona through the
change: a self-hosted user searching at night in dark mode, plus one
keyboard-only pass.

Tag every finding with its business impact: **High** (blocks the flow or
misleads), **Medium** (friction), **Low** (polish). A total below 16, or
any High finding, means the failing dimensions get fixed before the PR
merges.

## See also

- `DESIGN.md`: the contract this checklist enforces
- `../../references/accessibility-checklist.md`: the WCAG 2.1 AA checklist
- `test-driven-development`: how component tests get written

> Adapted from [addyosmani/agent-skills](https://github.com/addyosmani/agent-skills) (MIT), rewritten for videodeck conventions.
