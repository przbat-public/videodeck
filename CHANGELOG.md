# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.0] - 2026-09-14

First public release.

### Added

- Full-text search over downloaded videos (titles, descriptions, comments,
  transcripts) backed by Elasticsearch, with highlighting, sorting and
  category/channel/date filters
- Server-side yt-dlp download queue with pause/resume, per-folder concurrency
  limits, retries with backoff, and fast-fail for permanent errors
  (members-only, private, removed videos)
- Per-channel `config.json`: resolution cap (h264/aac preference), subtitle
  languages, comments, extra yt-dlp args, browser impersonation, concurrent
  fragments and SponsorBlock removal
- In-browser player with multi-language subtitle tracks and AI (OpenAI)
  video summaries with disk caching and cost metrics
- Status page with per-folder configuration editor, playlist
  (`list.json`) management and bulk actions with confirmation
- Chrome MV3 extension: enqueue videos straight from YouTube with live SSE
  progress
- Polish/English UI (react-i18next) with typed keys and locale parity tests
- Security hardening: Host-header allowlist (DNS rebinding), SSRF-guarded
  video URLs, restricted yt-dlp flags, Helmet, rate limiting, env validation
- Prometheus metrics (`/metrics`), `/health` and `/health/live` probes

[Unreleased]: https://github.com/OWNER/REPO/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/OWNER/REPO/releases/tag/v1.0.0
