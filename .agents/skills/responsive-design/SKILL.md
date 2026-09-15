---
name: responsive-design
description: videodeck responsive layout conventions and audit workflow. Assesses the device context (screen size, input method, motion preferences), enforces the DESIGN.md section 11 breakpoint, touch target and hover rules, runs the static UX scanner and a Playwright viewport probe, and reports prioritized defects before any visual change. Use when making the client responsive, auditing mobile and tablet behavior, or reviewing a layout change.
user-invocable: true
argument-hint: '"the change I plan" [--mode audit|guide|review]'
---

# Responsive design

> Synthesized from three public agent skills: [pbakaus/adapt](https://github.com/pbakaus/impeccable)
> (context assessment, per-device strategies, touch targets, clamp()),
> [web-app-ux-auditor](https://github.com/AjnasNB/web-app-ux-auditor-skill)
> (audit checklist and static scan signals) and
> [frontend-design-complete](https://github.com/nhatmobile1/claude-skills)
> (fluid typography, mobile-first patterns, Core Web Vitals). Rewritten for
> videodeck conventions.

Before touching any layout code, read `DESIGN.md` section 11 at the repo
root. It is the responsive contract: the breakpoints, the touch target
rule, the hover rule and the fluid type rule. This skill turns that
contract into a workflow, in the same way ui-design turns the rest of
DESIGN.md into a checklist.

## Context assessment

Before proposing a layout, name the target contexts. A screen size is not
enough:

- Device type and input: phone touch, tablet touch, desktop mouse and
  keyboard. Touch changes the minimum target size; a keyboard changes
  focus order; a mouse changes what hover may carry.
- Viewport: 360px (small phone), 768px (tablet portrait), 1024px and
  1400px (desktop). These are the contract breakpoints.
- Constraints that bite late: long Polish titles and channel names,
  200 percent text zoom, `prefers-reduced-motion`, dark mode, a slow
  connection loading a poster image.

## Checklist

1. **One column before shrinking.** At 360px every page stacks into a
   single column. No fixed widths wider than the viewport; no horizontal
   scroll. Grids collapse with `grid-template-columns: 1fr` or a
   `minmax(240px, 1fr)` floor.
2. **Breakpoints.** Mobile-first, three breakpoints max (360/768/1024
   from section 11). Adding a breakpoint is a contract change.
3. **Touch targets.** Every interactive element is at least 44x44px on
   touch. Compact 0.75rem controls from the desktop rhythm get more
   padding on small screens, never less.
4. **Inputs do not zoom.** Text inputs keep `font-size: 1rem` (16px) so
   iOS does not auto-zoom on focus.
5. **Hover is never the only way.** Anything revealed on `:hover` also
   reveals on `:focus-visible`, or the affordance is decorative. The card
   play overlay is the known offender.
6. **Fluid type.** Sizes between 360px and 1400px use `clamp()`. Fixed
   per-breakpoint font sizes are the exception.
7. **Media keeps its shape.** The player uses `aspect-ratio: 16/9`;
   thumbnails use percentage widths. Nothing outgrows its container.
8. **Dark parity.** Every breakpoint reads in both themes; a light-only
   or dark-only fix is a violation.
9. **Long content.** Titles truncate with `text-overflow: ellipsis` or
   wrap, never overflow the card or the queue row.
10. **Motion.** The 0.15-0.3s transition rule and the reduced-motion
    collapse apply at every viewport.

## Modes

- `guide` (default): plan a responsive change against the contract.
- `audit`: scan the client, probe real viewports, report defects.
- `review`: check an existing change or PR against the checklist.

## Audit workflow

1. Run the static scanner: `pnpm run ux:scan`. It flags review signals,
   not verdicts: hover-only reveals, removed focus outlines, buttons
   without a `type`, images without `alt`, and non-semantic click
   targets. Confirm every hit in code before reporting it.
2. Probe real viewports with Playwright against the running client
   (the e2e helpers show how to mock the API). For each of 360x800,
   768x1024 and 1280x720 check:

   - `document.documentElement.scrollWidth <= window.innerWidth` (no
     horizontal overflow) on the search, detail and status pages;
   - every visible button and input is at least 44x44px, except the
     deliberate inline text buttons named in DESIGN.md section 6;
   - the play overlay opens via keyboard focus, not just hover;
   - 200 percent zoom reflows without hiding the primary action;
   - dark mode matches light mode at the same viewport.

3. Report one table ranked by user impact:

| Area | Finding | Fix |
| --- | --- | --- |
| overflow | e.g. the toolbar is 520px wide at 360px | wrap buttons, stack the row |
| touch | e.g. a 28px icon-only button | pad to 44px |
| hover | e.g. the play overlay only shows on :hover | add :focus-visible |
| type | e.g. fixed 24px heading | clamp() between the bounds |
| theme | e.g. a light-only surface | token in both themes |

Skip false positives: semantic button colors and the player background
are deliberate (DESIGN.md section 2), and the compact desktop rhythm is
a documented tradeoff, not a bug at desktop width.

## Rationalizations

| Rationalization | Reality |
| --- | --- |
| "It fits at 768px, phones are an edge case" | 360px is in the contract; the overflow is real for a chunk of users. |
| "Hover users can mouse over, touch users can tap the card" | The overlay is invisible until hover; tap targets hidden by hover are broken on touch. |
| "A fixed width keeps the layout predictable" | Fixed widths are what overflow at the next smaller screen. |
| "The browser zooms inputs automatically" | iOS zooms when the font is under 16px, which hides half the form. |
| "We can test on one viewport and trust the rest" | Every breakpoint regresses independently; the probe runs all three. |

## Verification

- [ ] The change respects the three breakpoints and shows no horizontal
      overflow at 360px
- [ ] Interactive elements reach 44x44px on touch
- [ ] No affordance depends on hover alone
- [ ] Inputs keep a 16px font size
- [ ] Dark and light mode read the same at every viewport
- [ ] The static scan and the viewport probe were run and are green
- [ ] DESIGN.md section 11 still describes the actual breakpoints
