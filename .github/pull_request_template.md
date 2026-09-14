<!-- Thanks for the PR! A few checks before review: -->

- [ ] I ran `npm run format:check && npm run lint && npm run typecheck && npm test` (and `cd client && npm run test:e2e` when UI changed) — all green
- [ ] Tests cover the new behavior / the fixed bug
- [ ] UI text goes through i18n catalogs (pl + en, key parity enforced by `locales.test.ts`)
- [ ] API changes are reflected in `shared/schemas.ts`
- [ ] Commit messages follow Conventional Commits (commitlint is enforced)
- [ ] No secrets or personal data (`.env`, API keys, local paths) in the diff

### What

<!-- Short description of the change and why it is needed. -->

### How to verify

<!-- Steps a reviewer can run to see the change working. -->
