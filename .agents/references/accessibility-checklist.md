# Accessibility Checklist (videodeck, WCAG 2.1 AA)

> Adapted from [addyosmani/agent-skills](https://github.com/addyosmani/agent-skills) (MIT), rewritten for videodeck conventions.

Pair with the `ui-design` skill and `DESIGN.md` sections 8 and 2. Every
item below is checkable in code or in the browser.

## Keyboard

- [ ] Every interactive element is reachable and operable by keyboard:
  links, buttons, the Radix selects, checkboxes, the language switcher
- [ ] No keyboard traps; modals and popovers close on Escape
- [ ] Visible focus on `:focus-visible`: 3px `--color-focus` outline, 2px
  offset (inputs may use a border-color focus instead)
- [ ] Focus order follows the visual order; the video list rows tab in
  order

## Screen readers

- [ ] Every input has an accessible name: a linked `<label>` or
  `aria-label` (Radix selects carry theirs)
- [ ] Error banners use `role="alert"` and re-announce on change
- [ ] Toast messages are not the only signal of success or failure
- [ ] Images have meaningful `alt` (video thumbnails carry the title)
- [ ] Decorative elements stay out of the accessibility tree

## Visual design

- [ ] Text contrast at least 4.5:1 in both themes, white on
  `--color-primary` included (`#9aa0a6` muted text passes on dark)
- [ ] Information is never conveyed by color alone; queue states pair
  color with a text label
- [ ] Interactive targets are at least ~44px where feasible, small
  buttons stay keyboard-usable
- [ ] Dark theme (`data-theme='dark'`) keeps the same contrast bar

## ARIA

- [ ] ARIA used only when HTML semantics cannot express the state
  (progress via `aria-live` regions, not bare divs)
- [ ] `aria-label` text matches the visible language; the document
  `lang` follows the UI language switch
- [ ] The video player exposes its controls and subtitle tracks

## Motion and timing

- [ ] `prefers-reduced-motion` collapses animations and transitions
- [ ] No auto-advancing content without pause controls
- [ ] No flashing or strobing effects

## Testing

- [ ] Component tests assert by role and accessible name
  (`getByRole('button', { name: 'search.submit' })`), not by class
- [ ] jest-dom 7 cannot assert computed styles; assert rendered
  attributes and text instead
- [ ] The Playwright e2e suite is the smoke layer: keyboard navigation
  and the language/theme switches are covered there
- [ ] New visible text lands in both i18n catalogs and `locales.test.ts`
  enforces key parity
