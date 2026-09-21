# TODO

## Architecture

### Drop-in cinema integration
- [x] Standardize cinema adapter interface: each adapter should be a self-contained module with its own config schema, parsing logic, and error handling — implemented as `CinemaAdapterPlugin` in `src/main/cinemas/adapters/plugin.ts`
- [x] Add a cinema adapter registry plugin system — auto-discover adapters in `src/main/cinemas/adapters/` — implemented in `adapters/index.ts` + `registry.ts`
- [x] Document the adapter contract clearly (input: date range, output: Movie[] + availableDays + status) — see `src/main/cinemas/adapters/README.md` + JSDoc on `CinemaAdapterPlugin`
- [ ] Support runtime cinema configuration (add/remove cinemas via UI settings, not just code) — instance files in `src/main/cinemas/instances/*.ts` are the current mechanism; a UI editor is future work

### Ratings pipeline modularization
- [x] **Re-architect `ratingsEnricher.ts`** — DONE. Was 1000+ lines, now 154 lines (orchestrator only). Split into:
  - `ratingsEnricher.ts` — high-level workflow (Phase 0 → 1a → 1b → 1.5 → 2) ✅
  - `idResolver.ts` — Wikidata batch + per-film title search + cache management ✅
  - `ratingsFetcher.ts` — AlloCiné + RT + IMDB scraping orchestration ✅
  - `imdbDatasetClient.ts` — IMDB dataset lookup + refresh coordination ✅
  - `cacheDb.ts` — all SQLite read/write operations ✅ (kept original name `cacheDb.ts` instead of `cacheManager.ts` — cosmetic rename only, not worth the churn)
- [x] **Workflow consolidation**: clear pipeline stages ✅ — Phase 0 (cache) → 1a (batch SPARQL) → 1b (per-film title search) → 1.5 (IMDB dataset batch) → 2 (scrape all sources)
- [x] **Ratings scraper modularization**: each source implements a common `RatingSource` interface ✅ — see `src/main/ratings/RatingSource.ts`
- [x] Make the enrichment pipeline pluggable ✅ — `ratingSources.ts` is the registry; adding a new source = 1 import + 1 array entry, no orchestrator changes

## GUI / UX

### Structure and styling
- [x] **Clear structure/styling of the GUI** to increase adaptability — design tokens (spacing, radii, typography, z-index, shadows, transitions) added to `index.html` + TypeScript mirror in `src/renderer/styles/tokens.ts`
- [x] Extract inline styles into CSS modules or styled-components — shared presets in `src/renderer/styles/components.ts` (buttonStyles, cardStyles, inputStyles, badgeStyles, textStyles, dragRegion). App.tsx, ProgressBar, CinemaStatusBanner, MovieCard migrated to use tokens.
- [x] Create a design system with shared style tokens (spacing, colors, typography) — done in `index.html` `:root` block (8 spacing values, 6 radii, 8 font sizes, 5 font weights, 6 z-index levels, 3 transitions, 3 shadows, 10 brand colors)
- [x] Make the layout responsive to different window sizes — window now clamps to screen work area + sets `minWidth`/`minHeight` (900×600). The internal layout uses flexbox + `100vh` so it adapts to any window size ≥ minimum.
- [x] Separate presentation from logic in React components — App.tsx went from 853 → 682 lines (Task E): extracted `useTheme`, `useSchedule`, `useRatingsIPC`, `useRetryFailedLookups` hooks. Remaining 682 lines are presentation + filter pipeline (legitimately co-located).

### Internationalisation
- [x] **Check i18n completeness** — audited. All user-facing strings now in `src/shared/i18n.ts` (89 keys). Hardcoded French/English strings in components migrated to `t()`/`tFmt()`. Date/time formats locale-aware via `formatDecimal()`. Only intentional hardcoding: `'fr-FR'` in `shared/cinema.ts` for local French cinema conventions ("19h45", weekday abbreviations).
- [x] Add a language fallback chain: if a key is missing in the current locale, fall back to French, then English — implemented in `t()`: `currentLocale → DEFAULT_LOCALE (fr) → key string`
- [ ] Consider extracting i18n to JSON files for easier translation contributions — currently a single TS file, fine for 2 locales

## Quality

### Testing
- [x] **Unit tests** (vitest) for:
  - [x] Date/time helpers (parseHour, parseReleaseDate, toIsoDay, formatTime, formatHour, formatDayShort) — 50 tests
  - [x] Title normalization + coherence checking — 34 tests
  - [x] SQLite cache read/write operations (COALESCE UPSERT regression) — 25 tests
  - [x] VF/VO audio filter detection — 19 tests
  - [x] i18n translation, fallback chain, parameter substitution — 24 tests
  - [ ] IMDB dataset parsing (TSV → SQLite) — not yet
  - [ ] Cinema adapters (parse HTML/JSON → Movie[]) — needs Playwright for `browserFetch` mocking
- [ ] **Functional/integration tests** for:
  - [ ] Full enrichment pipeline (mock Wikidata + AlloCiné + RT responses)
  - [ ] Cache hit/miss scenarios
  - [ ] Schema migration paths
  - [ ] Graceful shutdown
  - [ ] Retry failed lookups button flow
- [ ] **E2E tests via Playwright for Electron** (TODO.md addition):
  - [ ] Phase 1: infrastructure (launch Electron with temp userData, smoke test for app boot + header visibility)
  - [ ] Phase 2: HAR fixture capture/replay (record real cinema + Wikidata + IMDB responses once, replay them in tests for deterministic adapter integration tests)
  - [ ] Phase 3: integration tests (cinema adapter HTML→Movie[], schedule fetch + ratings enrichment happy path, retry button flow, schema migration paths, IPC handlers)
  - [ ] Snapshot tests for UI regression (MovieCard layout, WeekGrid, LogViewer)
- [ ] Set up CI (GitHub Actions) to run typecheck + tests on every PR

### Error handling
- [x] **Fallback or clear error logging/feedback for scraping failures** (mostly done)
  - [x] Surface per-cinema, per-film, per-source failures to the UI (not just console) — MovieCard badges + CinemaStatusBanner
  - [x] Show "AlloCiné: blocked by Cloudflare" or "RT: page not found" in the movie card — `StatusBadge` component with localized tooltip + raw upstream message
  - [x] Add a "Retry failed lookups" button in the UI — implemented in App.tsx header, calls `ratings:retry` IPC handler
  - [x] Distinguish between "film has no rating" (absent) and "we couldn't fetch the rating" (error) — `statusColor()` returns grey for `absent`, red for `blocked`
  - [x] Log scraper failures with enough context to reproduce (URL, response size, first 200 bytes) — centralized Logger with file + memory dispatchers

## Performance
- [ ] BrowserWindow pool for `browserFetch` — reuse hidden windows instead of creating/destroying per call
- [ ] Consider pre-fetching Wikidata IDs at schedule fetch time (parallel with cinema HTML parsing)
- [ ] Investigate caching the Wikidata SPARQL endpoint's response at the HTTP level (304 Not Modified)
- [ ] Profile the SQLite schema for the 1.71M-row `imdb_ratings` table — consider a bloom filter or covering index

## Packaging
- [ ] Notarize the macOS .dmg (requires Apple Developer ID)
- [ ] Set up GitHub Releases with automated .dmg upload
- [ ] Add auto-update support (electron-updater)
- [ ] Create Windows and Linux builds (currently only macOS arm64)
