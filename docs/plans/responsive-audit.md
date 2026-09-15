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
| Overflow and breakpoints | 4 | Zero horizontal overflow at all three viewports. |
| Touch targets | 2 | Everything works, nothing but the switcher is far off; the 1-4px misses fail the 44px rule. |
| Inputs | 2 | The phrase input is 16px; channel and date inputs trigger iOS zoom. |
| Hover | 2 | One real hover-only affordance; the rest is decorative. |
| Media | 3 | Player keeps its ratio and never overflows; undersized on phones. |
| Motion | 4 | Reduced-motion collapse covers every transition. |
| Dark parity | 3 | Tokens are used per theme everywhere (code level); screenshot parity per viewport is a manual follow-up. |

## Out of scope for this pass (manual checks)

- 200 percent zoom reflow on each page.
- Dark mode versus light mode screenshots at 360px and 768px.
- Real device testing (the adapt skill asks for it; the probe above is
  emulation).

## Next steps

The findings map 1:1 onto the responsive-design skill checklist. Each fix is
a small, independently shippable change with a regression note in the PR:
hover counterpart for the overlay, 16px inputs, 44px touch padding on small
screens, switcher padding, player aspect ratio. The contract (DESIGN.md
section 11) is the acceptance bar for all of them.
