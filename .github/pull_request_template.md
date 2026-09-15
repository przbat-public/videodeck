<!-- Thanks for the PR! Fill the checklist, then the three sections. -->

### Checklist

- [ ] I ran the full local gate (all green):
      `pnpm run format:check && pnpm run lint && pnpm run lint:types && pnpm run lint:scripts && pnpm run test:scripts && pnpm run knip && pnpm run lint:deps && pnpm run humanizer:gate && pnpm run typecheck && pnpm test && pnpm run test:integration`
      plus `cd client && pnpm run test:e2e` when the UI, the API contract or the routing changed
- [ ] Tests cover the new behavior / the fixed bug (write the failing test first, RED before GREEN)
- [ ] UI text goes through i18n catalogs (pl + en, key parity enforced by `locales.test.ts`); no hardcoded Polish in `client/src` or `chrome-extension/src` (`pnpm run lint` enforces this)
- [ ] API changes are reflected in `shared/schemas.ts`
- [ ] `CHANGELOG.md` has an entry under _Unreleased_ when the change is user-visible
- [ ] Architecture delta receipt in the PR when package boundaries or services changed (see the archify skill)
- [ ] Commit messages and PR text are in English (see `CONTRIBUTING.md`)
- [ ] No secrets or personal data (`.env`, API keys, local paths) in the diff

### What

<!-- Short description of the change and why it is needed. -->

### How to verify

<!-- Steps a reviewer can run to see the change working. -->

### Definition of done

- [ ] RED→GREEN: the new test fails before the fix and passes after it
- [ ] i18n key parity holds (`cd client && pnpm run test:run`)
- [ ] `CHANGELOG.md` updated for user-visible changes

### Risk & rollback

<!-- What could this break? How do we revert it (single-commit revert? config flag?)? -->
