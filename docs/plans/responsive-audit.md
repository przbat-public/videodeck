# Responsive audit, September 2026

The first run of the responsive-design skill against the client, before any
visual change. Method: the static UX scanner (`pnpm run ux:scan`), a
Playwright viewport probe at 360x800, 768x1024 and 1280x720 on the search,
status and detail pages (mocked API, real CSS), a keyboard probe for the
card overlay, and a line-by-line confirmation of every scanner signal.

## What is already right

- **No horizontal overflow anywhere.** At 360px all three pages report
  `scrollWidth === innerWidth` with zero elements crossing the viewport.
  The single 768px media query (grid to one column, stacked toolbar and
  search bar, collapsed select widths) covers the phone size.
- **No dead click targets in the markup.** The scanner found zero
  `click-div`, zero `button-no-type` and zero `img-no-alt` signals in
  `client/src`.
- **Focus is not removed.** All seven `focus-outline-removal` signals are
  the documented pattern from DESIGN.md section 8: inputs swap the outline
  for a visible border color on focus. Confirmed line by line, not defects.
- **Hover feedback on buttons is decorative.** Eight of the nine
  `hover-only-reveal` signals are background changes plus a 1px lift on
  buttons and links. The action is available without hover, and
  `prefers-reduced-motion` collapses the transition. Not defects.

## Findings, ranked by user impact

| # | Severity | Area | Finding | Evidence | Fix direction |
| --- | --- | --- | --- | --- | --- |
| 1 | P1 | hover | The card play overlay only appears on `:hover`. A keyboard user tabbing to the card, and every touch user, never sees it. | `App.css:202` (`.video-card:hover .play-overlay`); probe: overlay opacity stays 0 with the link focused. | Add a `:focus-visible` (or `:focus-within`) counterpart rule; keep the transition. |
| 2 | P2 | inputs | `channel-input` and both `date-filter` inputs sit under 16px (15.2px and 14.4px), so iOS auto-zooms the page when they get focus. | Probe computed font sizes at 360px; `App.css` rules for `.channel-input` and `.date-filter`. | Set `font-size: 1rem` on these inputs. |
| 3 | P2 | touch | Almost every control misses the 44x44px touch target by 1 to 4px: toolbar buttons 42px, primary buttons 40px, date inputs 43px, the status link 42px. | Probe at 360px on all three pages. | On small screens, bump vertical padding so interactive elements reach 44px; keep the desktop rhythm. |
| 4 | P3 | touch | The PL/EN language switcher buttons are 25px tall. The segmented control is a documented exception to the primitives, but 25px is far under the touch rule on phones. | Probe at every viewport (34x25 and 35x25px). | Pad the switcher to 44px on touch; density can stay on desktop. |
| 5 | P3 | media | The detail player has `width: 70%` and no declared aspect ratio. It does not overflow (intrinsic video ratio applies after metadata), but on a phone the video shrinks to 70 percent of the viewport instead of using the full width. | `App.css` `.video-player-full`; no `aspect-ratio` anywhere in the client. | `aspect-ratio: 16/9`, full width at 768px and below, per DESIGN.md section 11. |

## Scorecard (0 broken, 4 meets the contract)

| Dimension | Score | Note |
| --- | --- | --- |
| Overflow and breakpoints | 4 | Zero horizontal overflow at all three viewports, including the 320px reflow width. |
| Touch targets | 4 | Every control reaches 44px on phones; guarded by an e2e test. |
| Inputs | 4 | All text inputs sit at 16px; iOS zoom no longer triggers. |
| Hover | 4 | The overlay now appears on keyboard focus; nothing depends on hover alone. |
| Media | 4 | Player fills the phone width and keeps 16:9 via aspect-ratio. |
| Motion | 4 | Reduced-motion collapse covers every transition. |
| Dark parity | 4 | Contrast measured programmatically in both themes; one real defect found and fixed. |

## Resolution log

All five findings are fixed, and the parity pass found a sixth.

1. **P1 hover overlay** - `.video-card-link:focus-visible .play-overlay`
   reveals the overlay to keyboard users (the card wraps the link, so the
   rule targets the link, not the card).
2. **P2 inputs under 16px** - `.channel-input` and `.date-filter` now use
   `font-size: 1rem`.
3. **P2 touch targets** - the 768px media query sets `min-height: 44px` on
   ui buttons, the row action buttons, the status link, the inputs and the
   selects, `min-height: 44px` on the checkbox label, and 44px minimums on
   the language switcher.
4. **P3 language switcher** - folded into finding 3 (44px on touch, the
   desktop density stays).
5. **P3 player** - `aspect-ratio: 16 / 9` on `.video-player-full`, full
   width inside the 768px media query.
6. **Dark mode accent text (found by the parity pass)** - the back link,
   comment action buttons, downloaded title links and checked select
   options used `--color-primary` as text, which reads at 3.19:1 on the
   dark surface. A new token `--color-primary-text` (`#4449b3` light,
   `#a5adff` dark, about 7:1 or better on both surfaces) replaces it, and
   DESIGN.md documents the token. The hover states moved to the same token
   plus an underline instead of darkening into illegibility.

## Verification

- `client/e2e/responsive.spec.ts` (16 tests, part of the e2e suite):
  overflow at 360/768/1280 on all three pages, overlay on keyboard focus,
  16px inputs, 44px targets at 360, player geometry, 320px reflow
  (the WCAG equivalent of 200 percent zoom), and a WCAG contrast scan of
  both themes on all three pages.
- Dark and light screenshots were captured at 360 and 768 during the pass;
  the contrast scan above is the repeatable version of that check.
- Real device testing remains the one human step (iOS Safari, Android
  Chrome), as the adapt skill asks. Everything automatable is automated.
