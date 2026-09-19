# DESIGN.md — videodeck design contract

The single contract for how videodeck looks and reads. Agents and humans
changing the UI follow this file. It describes what the code already does,
not aspirations: every color, component and rule below exists in the app.

## 1. Brand

A self-hosted tool for searching and browsing YouTube videos downloaded with
yt-dlp. The interface is quiet and functional: a light gray workspace,
white cards, one indigo accent, nothing decorative. Polish is the home
language; the UI ships pl and en catalogs with full parity.

Personality: precise, compact, dark-mode native. No gradients beyond the
header, no emoji decoration, no marketing voice.

## 2. Palette

Tokens live in `client/src/index.css` and are the only source of color.
Components must never hardcode a color: pick a token, or extend the token
set. There are two themes, both defined on the same tokens.

| Token | Light | Dark | Use |
| --- | --- | --- | --- |
| `--color-bg` | `#f5f5f5` | `#16181c` | page background |
| `--color-bg-soft` | `#f0f0f0` | `#23262d` | muted fills, table stripes |
| `--color-surface` | `#fff` | `#1d1f24` | cards, inputs, panels |
| `--color-text` | `#333` | `#e6e6e6` | body text |
| `--color-text-muted` | `#666` | `#9aa0a6` | secondary text |
| `--color-border` | `#e0e0e0` | `#3a3d45` | borders, dividers |
| `--color-primary` | `#5a5fd8` | `#5a5fd8` | accent, primary buttons |
| `--color-primary-hover` | `#4b56c9` | `#4b56c9` | accent hover |
| `--color-primary-text` | `#4449b3` | `#a5adff` | accent used as text: links, checked options |
| `--color-primary-soft` | `#eef0ff` | `#2e3352` | accent-tinted fills |
| `--color-focus` | `#5a5fd8` | `#5a5fd8` | focus ring |
| `--color-focus-ring` | `rgba(102, 126, 234, 0.2)` | `rgba(165, 173, 255, 0.3)` | soft halo on focused controls (checkbox, select trigger) |

Semantic colors keep white-on-color text and do not change with the theme:
success `#28a745`/`#218838`, danger `#dc3545`/`#c82333`, info `#17a2b8`/`#138496`,
warning `#ffc107`/`#e0a800` (update button), secondary `#5a6268`/`#495057`
(cancel button). Their soft backgrounds do change (`--color-danger-bg`,
`--color-info-bg`, `--color-warning-*`), as do the danger and warning text
tokens.

Rules:

- White text on `--color-primary` must stay at least 4.5:1 (WCAG AA). That
  is why the primary stays `#5a5fd8` in both themes.
- Alerts use the semantic soft backgrounds, never raw colors.
- The header gradient (`--color-primary` to `#764ba2`) is the one allowed
  decorative surface; the video player is the one allowed black surface.

## 3. Dark theme

`useTheme` resolves system/light/dark and writes the result to
`<html data-theme=…>`. Every component must look right in both themes:
tokens handle color, shadows deepen in dark, nothing hardcodes `#fff` or
light grays. New surfaces get tokens, never theme hacks.

## 4. Typography

System stack, no webfonts: `-apple-system, BlinkMacSystemFont, Segoe UI,
Roboto, Oxygen, Ubuntu, Cantarell, Fira Sans, Droid Sans, Helvetica Neue,
sans-serif`. Sizes stay in the 0.8-2.5rem range: 0.8rem metadata, 0.9rem
labels, 1rem body, 1.1-1.2rem titles, 2.5rem the app header. Weights: 500
for muted labels, 600-700 for headings and buttons. Nothing italic, nothing
uppercase beyond the PL/EN language buttons.

## 5. Layout and spacing

- Max content width 1400px, centered, 2rem page padding. The top bar
  shares that rhythm: 2rem above it (1rem on a phone, half the rhythm),
  so the space over the bar reads the same as the space under it.
- Cards: 8px radius (`--radius-card`), 1rem padding, no shadow. Titles and
  snippets clamp to two lines, and the grid rows share one height, so
  every card in a result page is the same size.
- Gaps are 0.25/0.5/1/2rem. 1rem is the default rhythm between controls.
- Controls are compact: 0.75rem vertical padding on inputs and buttons,
  0.3-0.55rem on small buttons.
- Lists use 58px rows; a running queue job grows to 84px for the progress
  bar, and an error log expands a row to 220px.

## 6. Components

Seven shared primitives in `client/src/components/ui/`:

- **Button** — variants: default (border, surface), `primary` (accent,
  white text), `danger`. Sizes: default and `small`. Disabled state at 60%
  opacity. Always a real `<button>`. Forwards a `ref`, so Radix `asChild`
  triggers (like the tooltip) can wrap it.
- **Select** — Radix-based combobox styled like the inputs; used for sort,
  category and channel. Options in a portal, checked option marked.
  Keyboard focus draws an inset ring inside the list; mouse hover stays a
  plain highlight.
- **Menu** — Radix DropdownMenu behind thin wrappers: trigger, content,
  items, checkbox items, link items (a real `<a>` through `asChild`, for
  entries that navigate), section labels and separators, all styled like the
  Select dropdown. The top bar gear menu (navigation, index actions,
  theme, language) composes it. Checkbox items keep the menu open on
  toggle; the same inset-ring focus rule as Select applies.
- **Checkbox** — Radix checkbox: a real button with the checkbox role, an
  18px box with `--color-primary` check state and a visible focus ring.
  The row is a `<label>`, so the text toggles too.
- **Tooltip** — Radix tooltip (trigger + content, self-contained, 300ms
  delay) replacing native `title` attributes. Inverted
  `--color-text`/`--color-surface` tokens, readable in both themes.
  Non-interactive triggers carry `tabIndex={0}` so keyboard users reach
  the info; new code never adds a native `title`.
- **ErrorMessage** — page-level banner or `compact` inline form; role
  `alert`, danger-soft background, danger text.
- **Loading** — centered spinner plus an optional label; the only loading
  pattern, no skeletons.

Composite patterns: top bar (brand icon, back link on the detail page,
gear menu), search bar (input + selects), video card
(thumbnail, title, muted metadata), queue item (status line, progress bar
while running, log on errors — the server drops the routine progress
lines before they reach the log), detail player (70% width, poster,
subtitle tracks). All live in `client/src/components/` and reuse the
tokens.

Data tables (the channel console on `/download`) follow one shape:

- A real `<table>` with a `<caption>` that sums the rows on screen,
  `<th scope="col">` headers and `aria-sort` on the one sortable column.
- The header row sticks while the table scrolls past. Its offset is the
  sticky queue bar's own height (`--channel-queue-bar-height`, published by
  a `ResizeObserver` on the bar), because the bar wraps on narrower screens
  and a hardcoded offset would hide the header behind it. The card that
  wraps the table uses `overflow: clip`, not `hidden`: a scroll container
  there would pin the header in place.
- Every row keeps one primary button for the action the row most needs and
  moves the rest into a `Menu` behind a `⋯` trigger with an `aria-label`.
  Six buttons on every row is what made the old stacked sections
  unreadable, and the menu keeps the keyboard order short. The menu lists the
  two updates first and the download third, so the order does not move when
  the primary button changes.
- The expanded row continues the table: it has no header of its own (the row
  names the channel, shows its warnings and carries the actions) and no
  nested card. The config form is the menu's `Edytuj config.json` entry, so
  the sheet has no edit button of its own and a channel without a
  `config.json` just says so.
- The "search in this channel" entry carries the channel name, because that
  is what the search filters by (`channelName.keyword`). The name comes from
  the `folders` map of `GET /api/videos/channels`, so a folder whose videos
  are not indexed has no name and the entry is left out rather than pointing
  at a filter that matches nothing. The entry is a router `Link` (still a
  real `<a>` for middle click and new tabs) so the click stays client side.
- A row that is working reports `aria-busy`, disables its own controls and
  shows the working chip until the action settles.

Icons come from **lucide-react** (stroke icons on the 24px grid,
`currentColor`); no hand-drawn paths and no icon fonts.

Deliberate exceptions to "primitives first", kept for density and purpose:
the inline text buttons in comment threads, and the per-row action buttons
in the video list (update, cancel, download), which use the semantic
warning/secondary/info tokens.

## 7. Motion

Almost none. Transitions are 0.15-0.3s on hover, focus and backgrounds.
`prefers-reduced-motion` collapses every animation and transition. No
entrance animations, no parallax.

## 8. Accessibility

- Focus: `:focus-visible` gets a 3px `--color-focus` outline, 2px offset.
  Inputs may use a border-color focus instead. The page landmark is the one
  exception: the app focuses it after a route change so screen readers
  announce the new page, and the landmark carries `tabindex="-1"` (never a
  tab stop), so its ring is suppressed rather than shown as a stray border
  on load.
- Contrast: text at least 4.5:1, primary button text included. Muted text
  stays readable in dark mode (`#9aa0a6` on `#1d1f24`).
- Every input has an accessible name: `aria-label` or a linked `<label>`.
  Radix selects carry `aria-label`; the menu trigger carries the app menu
  label and the menu itself follows the APG menu button pattern.
- Error banners use `role="alert"`; toasts are additional, not the only
  signal.
- A control that is running an action says so: `aria-busy` on the region,
  the busy control disabled, and a visible chip. Nothing depends on the
  disabled state alone to explain itself.
- Media: the player includes subtitle tracks; `useMediaCaption` is the one
  deliberate ignore, documented inline.

## 9. Voice and tone

UI copy lives in the i18n catalogs (`client/src/i18n/locales/`), Polish and
English, key parity enforced by `locales.test.ts`. Rules:

- Commands are verbs: Pobierz, Odśwież, Pauza.
- Labels are nouns or short phrases, never sentences with periods.
- Errors say what failed and what to do: "Nie udało się wyszukać filmów".
- No exclamation marks, no emoji, no "please".
- New UI text gets both catalogs in the same change; never hardcode a
  string in a component.

## 10. File structure

- `client/src/index.css` — tokens, themes, resets, focus, motion.
- `client/src/App.css` — layout and component styles; colors only through
  tokens.
- `client/src/components/ui/` — the seven primitives.
- `client/src/components/` — composite components and pages.

Changing the design means changing tokens or components, never
copy-pasting styles. If a component needs a color that has no token, add
the token to `index.css` for both themes and mention it in this file.

## 11. Responsive

The client is mobile-first. Three breakpoints drive layout changes: 360px
(small phone), 768px (tablet portrait) and 1024px (desktop). The current
codebase implements the 768px one; the others are the contract for new
work.

- Every screen reflows at 360px without horizontal scrolling. Content
  stacks into one column before it shrinks, and grids use a
  `minmax(240px, 1fr)` floor or `1fr`.
- Touch targets are at least 44x44px wherever a pointer can hit them.
- Text inputs keep a 16px font size so iOS never auto-zooms on focus.
- No affordance depends on hover alone. Anything revealed on `:hover`
  also reveals on `:focus-visible`, or the affordance is decorative.
- Fluid type sizes use `clamp()` between the 360px and 1400px bounds.
  Fixed font sizes per breakpoint are the exception.
- Media keeps its aspect ratio: the player uses `aspect-ratio: 16/9`,
  thumbnails use percentage widths, nothing outgrows its container.
- Dark mode must read as well as light mode at every breakpoint.
- Long Polish titles and channel names truncate with ellipsis or wrap;
  they never overflow a card or a queue row.
- The channel console table collapses into one card per channel below
  768px: the header row is hidden, every cell prints its column name from
  `data-label`, the sticky header rule stops applying, and the row actions
  keep their 44px height. A table never scrolls sideways on a phone.
- New breakpoints, a changed grid floor or a removed hover affordance are
  a contract change: update this section and run the responsive-design
  skill audit.

The `.agents/skills/responsive-design` skill turns this section into a
workflow. The static scanner (`pnpm run ux:scan`) flags hover-only
reveals, removed focus outlines, buttons without a `type`, images without
`alt` and non-semantic click targets as review signals.
