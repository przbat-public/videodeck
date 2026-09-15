# Releasing

The project is a self-hosted tool, not an npm package: a release is a git tag
plus a GitHub Release entry, announced in the CHANGELOG.

## Checklist

1. Verify the full local gate from the repo root:
   ```bash
   npm run format:check && npm run lint && npm run lint:types && npm run lint:scripts && npm run test:scripts && npm run knip && npm run lint:deps && npm run typecheck && npm test && cd client && npm run test:e2e
   ```
2. Confirm CI is green on `main` (all required checks).
3. Bump the version in the four `package.json` files (root, `server/`,
   `client/`, `chrome-extension/`). Keep them in lockstep.
4. Move the `## [Unreleased]` CHANGELOG section to a dated release entry
   (Keep a Changelog format), with the release date.
5. Create the tag and release:
   ```bash
   git tag vX.Y.Z
   git push origin vX.Y.Z
   gh release create vX.Y.Z --title "vX.Y.Z" --notes "$(sed -n '/^## \[X.Y.Z\]/,/^## \[/p' CHANGELOG.md)"
   ```
6. Upgrade notes for self-hosted operators: state whether the ES mapping or
   the SSE contract changed (both require a reindex / a coordinated
   extension update when they do).
