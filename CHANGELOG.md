# Changelog

## v0.13.0 (2026-09-21)

### Fixes
- **Dedup: "avant-première" prefix** — "En avant-première Heart Of The Beast" now deduplicates with "Heart Of The Beast". Added `dedupTitle()` to shared/cinema.ts that strips avant-première/extended/final cut/version longue prefixes before grouping.
- **Wikidata title search: colons** — "Avengers : Endgame" was returning 0 results because colons confuse the wbsearchentities API. Now strips colons before searching.
- **Wikidata title search: avant-première prefix** — findByTitle() now strips "Avant-première :" and "Avant-première" prefixes (was only stripping "En avant-première").
- **Wikidata title search: opera suffixes** — strips "(Metropolitan Opera)" parenthetical suffixes.
- **Cache poisoning fix** — Wikidata entities with no external IDs (no IMDB/RT/AlloCiné) are NO LONGER cached permanently. Previously, if a film was found on Wikidata but had no IDs, it was cached as "absent" forever — even if the user later added IDs to Wikidata. Now the app re-checks each launch until IDs appear.


## v0.12.12 (2026-09-21)

### Optimization
- **AlloCiné pages 100× smaller** — switched from `browserFetch` (returns full rendered DOM with CSS = ~600 KB/page) to `pooledFetch` (returns raw server HTML = ~50 KB/page). The rating CSS classes are server-rendered — no JavaScript needed. Falls back to `browserFetch` automatically if Cloudflare is detected. Expected reduction: 18.5 MB → ~1.5 MB for 32 AlloCiné pages, plus faster fetch (no BrowserWindow overhead).


## v0.12.6 (2026-09-21)

### Feature
- **Network recorder/replayer** — captures ALL HTTP traffic (fetchWithTimeout + browserFetch) to a JSON fixture for deterministic E2E tests. Two modes: `ARVE_RECORD=path` records real responses during a live app run; `ARVE_REPLAY=path` serves recorded responses in tests with no network needed. Scripts: `npm run capture:network` (record), `npm run test:e2e:replay` (replay).


## v0.12.5 (2026-09-20)

### Quality
- **Parser contract tests (Layer 3)** — 12 tests using a real AlloCiné HTML fixture ("La Frappe", cfilm=324170). Verifies rating extraction (press=3.9, audience=3.6, votes=74) + edge cases (Cloudflare challenge, empty HTML, out-of-range values, CSS class vs stareval-note priority). Exposed `extractRatingBySection` and `extractVoteCount` as exports for testability.


## v0.12.4 (2026-09-20)

### Fix
- **HAR capture script fixed** — Playwright `recordHar` only captures renderer-side traffic, but our fetches happen in the main process. Switched to Electron `--log-net-log` flag which captures ALL Chromium network traffic (main process + hidden BrowserWindow + renderer). Output is `arvecinema-netlog.json` (Chromium net log format, viewable in chrome://net-export/).


## v0.12.3 (2026-09-20)

### Fix
- **Wikidata User-Agent fix** — Wikimedia 403-blocks bare User-Agent strings without a contact URL. Changed UA to include GitHub repo URL per their policy. This was the root cause of zero ratings.
- **Network tracking cold-start fix** — first network call was failing because trackNetworkStart was outside the try block.


## v0.12.2 (2026-09-20)

### Fix
- **Eliminated SPARQL timeouts** — replaced all Wikidata SPARQL queries with the MediaWiki search API (`haswbstatement:P1265=<id>` + `wbgetentities`). SPARQL had a 60-second timeout and frequent HTTP 429 rate limiting. The search API is ~10× faster (<500ms vs 5-30s), better rate-limited, and more reliable. Batch lookup now uses parallel search queries (5 at a time) + a single batch `wbgetentities` call instead of one complex SPARQL VALUES query.


## v0.12.1 (2026-09-20)

### Infrastructure
- **HAR capture script** — `npm run capture:har` launches the app with Playwright's `recordHar` enabled, capturing every HTTP request + response (cinema schedules, Wikidata, AlloCiné, RT, IMDB dataset) to `/home/z/my-project/download/arvecinema-capture.har`. Used to create deterministic E2E fixture replay tests (Layer 4 in TESTING.md).
- Architecture audit fixes: documented the orchestrator's `imdbDatasetClient` lifecycle import exception, documented the DiagnosticsTab lazy-load IPC boundary crossing.

## v0.12.0 (2026-09-20)

### Architecture
- **Drop-in cinema adapter plugin system** — both adapter TYPES and cinema INSTANCES are auto-discovered via Vite's `import.meta.glob()`. Adding a cinema = drop a `.ts` file in `instances/`. Adding a new adapter type = drop a `.ts` file in `adapters/`. No edits to any other file.
- **BrowserWindow pool for browserFetch** — per-domain idle window reuse eliminates ~500ms Chromium-init overhead per call. Expected ~10s savings per AlloCiné enrichment cycle. Ad-blocker now installed once per session (was per-call).
- **Ratings pipeline modularization verified** — orchestrator is 154 lines (was 1000+), clean separation via `IdResolver` + `RatingsFetcher` interfaces, pluggable `RatingSource` registry.
- **App.tsx refactored** — 853 → 692 lines (−19%). Extracted 4 custom hooks: `useTheme`, `useSchedule`, `useRatingsIPC`, `useRetryFailedLookups`.
- **Design system** — 50+ CSS variables (spacing, radii, typography, z-index, shadows, brand colors) + 16 shared style presets in `src/renderer/styles/`. Window now clamps to screen work area + enforces 900×600 minimum.
- **Stale file cleanup** — deleted 3 duplicate adapter files from the old location (now only in `adapters/`).

### Features
- **Centralized logging framework** — pluggable Logger with console + memory + file dispatchers. All main-process modules route through `log.{component}.{level}()`. LogViewer receives real-time `log:append` IPC events. File dispatcher writes to `userData/logs/arvecinema.log` with 5MB rotation.
- **Retry failed lookups button** — ⚡ button in header appears when blocked sources exist. Calls `ratings:retry` IPC handler which re-fetches only `status === 'blocked'` sources. Button shows yellow → spinner → green (recovered) visual states.
- **MovieCard failure surfacing** — distinguishes `absent` (grey dot, "no rating exists") from `blocked` (red dot + dashed border + ⚠, "fetch failed"). Localized tooltips with raw upstream error messages.
- **DiagnosticsPanel** — new 🩺 tab in About panel showing per-cinema health, per-source counts (ok/blocked/absent/pending), blocked films with error messages, and "Copy diagnostics" button that puts a structured report on the clipboard for GitHub issues.

### Quality
- **200 unit tests** (vitest) — date/time helpers, title normalization, cacheDb CRUD (COALESCE UPSERT regression), i18n fallback chain, VF/VO detection, plugin registry + auto-discovery canaries. Runs in 1.6s.
- **7 E2E tests** (Playwright + Electron) — app launch, header, cinema selector, filter bar, view toggle, about panel, diagnostics tab. Runs in 60s via `npm run test:e2e` (auto-manages Xvfb on Linux).
- **i18n completeness audit** — 102 translation keys (was 89), all with FR + EN. Added fallback chain (`currentLocale → DEFAULT_LOCALE → key`), `tFmt()` for parameter substitution, `formatDecimal()` for locale-aware number formatting. Zero hardcoded UI strings.
- **CI workflow** — GitHub Actions runs typecheck + 200 unit tests + 55 smoke checks + build on every PR/push to main.
- **TESTING.md** — comprehensive testing strategy mapping 15 failure modes to 6 test layers. Every test file has a coverage header explaining what it catches/misses.
- **ERROR_HANDLING.md** — documents the user-feedback loop (server changes → user notices → diagnostics → bug report → fix) and error categories with user-facing messages.

### Infrastructure
- Added `npm run test`, `test:watch`, `test:coverage`, `test:e2e`, `test:e2e:headed` scripts.
- `scripts/run-e2e.sh` — manages Xvfb setup/teardown on Linux for headless E2E tests.
- `scripts/smoke-test-i18n.mjs` + `scripts/smoke-test-logger.mjs` — automated regression checks.

## v0.11.3 (2026-09-19)

- Version bump (no code changes since v0.9.0 — packaging release)

## v0.9.0 (2026-09-18)

### Architecture
- **Bonneville switched to boxOfficeApi adapter** — cinechateau.fr redesigned to Gatsby 5.14.6 using the same JSON API as Mont-Blanc and Cluses (theaterId: W7412)
- **Batch SPARQL for Wikidata lookups** — single query for all AlloCiné IDs instead of per-film queries, eliminates HTTP 429 rate limiting
- **Phase 0: instant cache application** — all cached ratings (IMDB + AlloCiné + RT) applied synchronously before any network calls
- **Incremental IMDB dataset lookup** — IMDB rating applied within 1ms of each film's Wikidata ID resolution, not after all films finish
- **Phase 2 sorted by next screening time** — films showing today are enriched first
- **AlloCiné ID lookups skip title coherence check** — the ID (P1265) is authoritative; French/English title mismatches no longer cause false rejections

### Cleanup
- Deleted 4 dead files: SettingsPanel.tsx, credentials.ts, mpdbClient.ts, RatingProvider.ts
- Renamed project directory: cine-montblanc-app → arvecinema
- Hardened .gitignore (cache.db, .vite, *.archived, debug/, etc.)
- README: fixed component count, cache.db paths, preload channels, cineChateau marked as sleeping backup
- Metric console.logs gated behind ARVE_DEBUG
- Added @types/node devDependency
- App packaging: asar archive, maximum compression, arm64-only, trimmed icon files

## v0.8.2 (2026-09-18)
- Skip title coherence check for AlloCiné ID lookups (batch + per-film)

## v0.8.1 (2026-09-18)
- Batch SPARQL: `findByAllocineIdsBatch()` queries up to 50 AlloCiné IDs in one SPARQL query

## v0.8.0 (2026-09-18)
- Bonneville: switched from HTML scraper to boxOfficeApi adapter (theaterId W7412)
- Chamonix: cineVox internal IDs no longer treated as AlloCiné IDs
- Release date parser: 6-month threshold instead of month-comparison for year inference

## v0.7.5 (2026-09-18)
- `allocineIdFromMovie()` only returns real AlloCiné IDs for boxOfficeApi cinemas
- Phase 0 checks IMDB dataset directly (imdb_ratings table)
- Bonneville diagnostic logging (checks for .hr_film blocks after browserFetch)

## v0.7.4 (2026-09-18)
- Phase 0: IMDB dataset direct lookup alongside ratings_cache

## v0.7.3 (2026-09-18)
- Timing breakdown logs in schedule:fetch + enrichment pipeline

## v0.7.2 (2026-09-18)
- Phase 0/1/2 timing instrumentation

## v0.7.1 (2026-09-18)
- Incremental IMDB dataset lookup in Phase 1 (applied per-film as Wikidata IDs resolve)

## v0.7.0 (2026-09-18)
- Phase 0: apply ALL cached values synchronously before network calls
- Phase 2 queue sorted by next screening time
- Progress counter accounts for Phase 0 fresh cache hits

## v0.6.16 (2026-09-18)
- JSON export uses renderer's in-memory state (instant, no re-fetch)

## v0.6.15 (2026-09-18)
- Fixed dev:get-network-state IPC crash (require() → static import)
- HH:MM:ss.sss timestamps on all debug log lines

## v0.6.14 (2026-09-18)
- Network activity tracking for fetchWithTimeout calls (Wikidata + boxOfficeApi)
- Late-subscriber race condition fix (dev:get-network-state IPC)

## v0.6.13 (2026-09-18)
- Graceful shutdown: cancellation token + BrowserWindow cleanup + SQLite close
- before-quit handler for Cmd+Q / Alt+F4

## v0.6.12 (2026-09-18)
- About panel: removed AlloCiné + RT attribution blocks, added personal navigation disclaimer

## v0.6.11 (2026-09-18)
- cineChateau + cineVox adapters switched to browserFetch (Cloudflare bypass)
- parseReleaseDate handles "Sortie : 9 septembre" (no year) — 6-month threshold
- dev:export-all awaits enrichment completion

## v0.6.10 (2026-09-18)
- SQLite schema versioning: SCHEMA_VERSION in meta table, forward migration + nuclear rebuild on downgrade

## v0.6.9 (2026-09-18)
- JSON export fetches ALL 4 cinemas via dev:export-all IPC

## v0.6.8 (2026-09-18)
- ExportButton dropdown: CSV + JSON export options
- JSON export includes full Movie objects with showtimes, cast, genres, runtime, statuses

## v0.6.7 (2026-09-18)
- Cross-cinema cache sharing (title prefix LIKE query)
- Release date extraction from cineVox + cineChateau pages
- "Final Cut" / "Director's Cut" suffix stripping in Wikidata title search

## v0.6.6 (2026-09-18)
- Dev-only CSV export button

## v0.6.5 (2026-09-18)
- Bottom progress bar (3px) showing enrichment progress 0→100%
- Refresh icon spinner when network activity is in flight
- ratings:progress + network:activity IPC channels

## v0.6.4 (2026-09-18)
- Timing instrumentation (timedSync / timedAsync helpers)
- Images disabled in hidden BrowserWindow (fixes ffmpeg errors, speeds up page loads)

## v0.6.3 (2026-09-18)
- UPSERT (ON CONFLICT DO UPDATE) for ratings_cache — preserves unspecified columns
- isFresh() requires AC + RT status to be non-undefined (Phase 2 no longer skipped)
- Phase 2 starts from existing cache entry (preserves IMDB from Phase 1.5)

## v0.6.2 (2026-09-18)
- Fixed AlloCiné + RT ratings disappearing (INSERT OR REPLACE was clobbering unspecified columns)

## v0.6.1 (2026-09-17)
- About panel with license, dependencies, attributions, GitHub links

## v0.6.0 (2026-09-17)
- Unified SQLite cache.db (ids_cache + ratings_cache + imdb_ratings + meta tables)
- Auto-migration from old JSON cache files
- better-sqlite3 dependency + postinstall rebuild script

## v0.5.0 (2026-09-17)
- IMDB ratings via official public dataset (title.ratings.tsv.gz)
- SQLite-backed dataset with 36h TTL, background refresh
- IMDB browserFetch + GraphQL parked as sleeping backups

## v0.4.0 (2026-09-17)
- IMDB dataset replaces GraphQL + browserFetch as primary ratings source

## v0.3.x (2026-09-16 to 2026-09-17)
- IMDB GraphQL batch exploration (ultimately retired due to predefinedList auth block)
- browserGraphqlFetch (hidden BrowserWindow + in-page fetch)
- Ad/tracker blocker for hidden BrowserWindow
- AWS WAF challenge handling
- Title coherence improvements (subtitle markers, Final Cut, Director's Cut)
- Electron 30 → 33, package.json metadata, GitHub URLs

## v0.2.x (2026-09-16)
- Multi-cinema support, week/day views, i18n, theming
- Progressive ratings enrichment (Wikidata → IMDB/RT/AlloCiné)
- Connection pool, in-flight deduplication, cache tiers

## v0.1.x (2026-09-15)
- Initial single-cinema script, evolved to Electron app
- Tarball distribution, icon generation, BSD-3-Clause license
