# TODO

## Architecture

### Drop-in cinema integration

- [x] Standardize cinema adapter interface — `CinemaAdapterPlugin` in `src/main/cinemas/adapters/plugin.ts`
- [x] Cinema adapter registry plugin system — auto-discover via `import.meta.glob()` in `adapters/index.ts` + `registry.ts`
- [x] Document the adapter contract — see `src/main/cinemas/adapters/README.md` + JSDoc
- [x] TRUE drop-in: both adapter types AND cinema instances auto-discovered. Drop a `.ts` file in `adapters/` or `instances/` — no edit to any other file.
- [x] **`testOnly` flag for canary/template instances** — `registry.ts` registers them in dev + unit tests but skips them from bundled release builds (`import.meta.env.DEV`), so "Example Cinema (Canary)" never reaches end users. Covered by unit tests (both modes) + an e2e absence assertion.
- [x] **Runtime cinema configuration with settings UI** — Phase 1: `userData/custom-cinemas.json` (JSON-only, validated through the same plugin pipeline, corruption-safe). Phase 2: About panel → 🎬 Cinemas tab (`CustomCinemasEditor`) — add/edit/remove rows, per-kind required fields, save → `cinemas:save-custom` IPC writes + re-registers, `cinemas:changed` event refreshes the cinema list live, main-side rejections surfaced per row. Backed by `customCinemasIpc.ts` (electron-free, 9 unit tests) + 2 UI-flow e2e tests.

### Ratings pipeline modularization

- [x] **Re-architect `ratingsEnricher.ts`** — 154 lines (was 1000+). Split into 5 modules.
- [x] **Workflow consolidation** — Phase 0 (cache) → 1a (batch Wikidata) → 1b (per-film title) → 1.5 (IMDB dataset) → 2 (scrape all sources)
- [x] **Ratings scraper modularization** — each source implements `RatingSource` interface (`src/main/ratings/RatingSource.ts`)
- [x] **Pluggable enrichment pipeline** — `ratingSources.ts` registry; adding a source = 1 import + 1 array entry

### Wikidata client

- [x] **Eliminated SPARQL** — replaced with MediaWiki search API (`haswbstatement:P1265=` + `wbgetentities`). 10× faster, no timeouts.
- [x] **User-Agent fix** — Wikimedia 403-blocks bare UA strings; added GitHub URL per their policy.
- [x] **Network tracking cold-start fix** — `withNetworkTracking` wrapped in try/catch so first call doesn't fail.
- [x] **Sequential batch searches** — 200ms delay between Wikidata API calls to respect rate limits.
- [x] **No-cache for incomplete entities** — Wikidata entries with no external IDs (no IMDB/RT/AlloCiné) are NOT cached permanently. Re-checked each launch until IDs appear.

### Title cleaning system

- [x] **Systematic title-cleaning rules** — `src/shared/titleRules/` with per-language files (fr.ts, en.ts). 44 patterns covering avant-première, soirée spéciale, extended, remastered, director's cut, final cut, version longue, opera, live, etc.
- [x] **Retry-without-stripping** — `findByTitle()` tries cleaned title first, retries with original if no results (handles "Final Cut" as a real title).
- [x] **Deduplication in both views** — `dedupTitle()` used in day view AND week view (was only day view).

## GUI / UX

### Structure and styling

- [x] **Design system** — 50+ CSS variables (spacing, radii, typography, z-index, shadows, brand colors) in `index.html` + TypeScript mirror in `src/renderer/styles/tokens.ts`
- [x] **Shared style presets** — `src/renderer/styles/components.ts` (buttonStyles, cardStyles, inputStyles, badgeStyles, textStyles, dragRegion)
- [x] **Responsive layout** — window clamps to screen work area + enforces 900×600 minimum
- [x] **App.tsx refactored** — 853 → 682 lines. Extracted 4 custom hooks: `useTheme`, `useSchedule`, `useRatingsIPC`, `useRetryFailedLookups`
- [x] **Movie year displayed** — after title in smaller, lighter font (14px, `--text-muted`)

### Internationalisation

- [x] **i18n completeness audit** — 102 translation keys, all with FR + EN. Zero hardcoded UI strings (verified by `smoke-test-i18n.mjs`).
- [x] **Fallback chain** — `t()`: `currentLocale → DEFAULT_LOCALE (fr) → key string`
- [x] **Parameter substitution** — `tFmt(key, { param: value })` for dynamic strings
- [x] **Locale-aware number formatting** — `formatDecimal()` (comma in FR, dot in EN)
- [ ] Consider extracting i18n to JSON files for easier translation contributions

## Quality

### Testing

- [x] **Unit tests** (vitest, 307 tests, ~2s):
  - [x] Date/time helpers — 50 tests
  - [x] Title normalization + coherence checking — 34 tests
  - [x] Title cleaning rules (FR + EN patterns) — 50 tests
  - [x] SQLite cache read/write (COALESCE UPSERT regression) — 25 tests
  - [x] VF/VO audio filter detection — 19 tests
  - [x] i18n translation, fallback chain, parameter substitution — 24 tests
  - [x] AlloCiné HTML parser (with real fixture) — 12 tests
  - [x] Plugin registry + auto-discovery canaries + `testOnly` release filter — 52 tests
  - [x] Runtime custom registry (custom-cinemas.json) — 17 tests
  - [x] **IMDB dataset parsing (TSV → SQLite)** — 15 tests: `parseLine` row validator (header, `\N`, malformed ids/ratings, range checks), zlib streaming split across chunk boundaries (5000-row fixture), full TSV → `clearAndBulkInsertImdbRatings` → `getImdbRatingsBatch` pipeline + replace-on-refresh + poisoning guard. Found + fixed a lax id check (`tt\d+` regex now strict).
  - [x] Custom-cinemas IPC file I/O (`readCustomCinemasFile` / `saveCustomCinemas`) — 9 tests: missing/malformed/wrong-shape file, write + re-register, invalid entries reported per-row, remove-all, non-array rejected WITHOUT writing, file persistence across a simulated restart
- [x] **E2E smoke tests** (Playwright + Electron, 11 tests):
  - [x] App launch, header, cinema selector (incl. canary ABSENT from bundled app), filter bar, view toggle, about panel, diagnostics panel
  - [x] Custom cinemas: file-based registration + invalid-entry isolation + **settings UI flow** (add via form → save → live registry refresh) + form validation error state
- [x] **Replay-based E2E in CI** — `test/fixtures/network-capture.json` (80 responses, 3.3 MB) recorded headlessly with `node scripts/record-replay-fixture.cjs`. `npm run test:e2e:replay` runs the full e2e suite against the fixture (17s vs 47s live, no live cinema-site traffic for recorded URLs). Bodies > 512 KB (IMDB dataset, big Wikidata batches) fall through to the real network via partial replay. CI job `e2e-replay` runs it on every push/PR.
- [x] **Shutdown coordinator restored** — `doShutdown` had regressed to a bare `SIGKILL`, silently skipping DB close, log flush AND the fixture save; `gracefulShutdown()` was dead code + its `require()`s could never resolve in the built bundle (wrong relative paths, invisible to typecheck). Now static imports: `[network-recorder] saved 84 recorded responses` actually runs again.
- [x] **CI workflow** — GitHub Actions: typecheck + 307 unit tests + smoke checks + replay e2e + build on every PR/push
- [x] **TESTING.md** — comprehensive testing strategy mapping 15 failure modes to 6 test layers
- [x] **ERROR_HANDLING.md** — documents the user-feedback loop + error categories
- [x] **Coverage headers** — every test file has a header explaining what it catches/misses
- [ ] Functional/integration tests (full enrichment pipeline with replayed Wikidata — cache hit/miss, schema migration, retry button flow)
- [ ] Snapshot tests for UI regression (MovieCard layout, WeekGrid, LogViewer)

### Error handling

- [x] **Per-cinema/per-film/per-source failure surfacing** — MovieCard badges + CinemaStatusBanner
- [x] **"Retry failed lookups" button** — ⚡ in header, calls `ratings:retry` IPC handler
- [x] **Distinguish absent vs blocked** — grey dot for absent (no rating), red ⚠ for blocked (fetch failed)
- [x] **Centralized logging** — Logger with console + memory + file dispatchers, LogViewer in About panel
- [x] **DiagnosticsPanel** — 🩺 tab showing per-cinema health, per-source counts, blocked films, "Copy diagnostics" for bug reports
- [x] **Context-rich error messages** — URL, response size, first 500 chars logged on scraper failures

## Performance

- [x] **BrowserWindow pool for browserFetch** — per-domain idle window reuse, ~10s saved per AlloCiné enrichment cycle
- [x] **AlloCiné pages 100× smaller** — switched from `browserFetch` (full DOM ~600 KB) to `pooledFetch` (raw HTML ~50 KB). Falls back to `browserFetch` if Cloudflare detected.
- [ ] Consider pre-fetching Wikidata IDs at schedule fetch time (parallel with cinema HTML parsing)
- [ ] Investigate caching Wikidata API responses at the HTTP level (304 Not Modified)
- [ ] Profile the SQLite schema for the 1.71M-row `imdb_ratings` table — consider a bloom filter or covering index

## Infrastructure

- [x] **Network recorder/replayer** — `npm run record` (interactive) or `node scripts/record-replay-fixture.cjs` (headless, auto-quits after the enrichment cycle) captures ALL HTTP traffic (fetchWithTimeout + browserFetch) to `test/fixtures/network-capture.json`. `npm run run replay` / `test:e2e:replay` runs the e2e suite using the fixture. Bodies > 512 KB are skipped at record time (partial replay fallback).
- [x] **`npm run help`** — lists all commands with descriptions
- [x] **GitHub Actions CI** — `.github/workflows/ci.yml`: typecheck + unit tests + smoke checks, **replay-based E2E job** (ubuntu runner, Xvfb, electron-rebuild), and the production build
- [x] **better-sqlite3 ABI script fixes** — the Node ABI and the Electron ABI are incompatible; `rebuild:electron` now uses `electron-rebuild -f -w better-sqlite3` (the old `electron-builder install-app-deps` was silently a no-op), and `package*` / `build` / `test:e2e` scripts self-rebuild for the right ABI. Table + symptoms in `TESTING.md` + `README.md`.
- [x] **Safe clean scripts** — `clean` / `clean:full` no longer run `git reset --hard`, so uncommitted changes survive cleanup.

## Packaging

- [ ] Notarize the macOS .dmg (requires Apple Developer ID)
- [ ] Set up GitHub Releases with automated .dmg upload
- [ ] Add auto-update support (electron-updater)
- [ ] Create Windows and Linux builds (currently only macOS arm64)
