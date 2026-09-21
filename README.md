# ArveCinema

Electron desktop app for cinema showtimes in the Arve Valley (Sallanches, Cluses, Bonneville, Chamonix).

Built with Electron 33 + React 18 + TypeScript + electron-vite. BSD-3-Clause licensed.

## Features

- **4 cinemas** via a modular adapter registry — add/remove a cinema in one line
- **Day view**: one card per film (deduplicated across cinemas), sorted by next screening / title / cinema
- **Week view**: swimlane grid with showtime chips positioned by real start/end time, middle-click drag to pan
- **Filters**: cinema multi-select, day picker, audio version (VF/VO), hour range (quarter-hour slider), title/director/actor search
- **Ratings**: progressive enrichment via Wikidata → AlloCiné (press + audience) + IMDB + Rotten Tomatoes (tomatometer)
- **Dark / light theme**, French / English UI
- **Offline cache**: Wikidata IDs cached permanently, ratings cached 24h

## Prerequisites

- **Node.js** ≥ 18.0 (required by Electron 33)
- **npm** ≥ 9 (or compatible pnpm/yarn)
- **Git** (to clone the repo)
- **Network access** on first launch (Wikidata + AlloCiné/IMDB/RT are fetched lazily, then cached)
- **Linux only**: `libnss3`, `libatk1.0-0`, `libatk-bridge2.0-0`, `libgbm1`, `libgtk-3-0` (Electron runtime deps; the hidden `BrowserWindow` used for Cloudflare bypass needs these too)
- **macOS only (packaging)**: Xcode Command Line Tools + a Developer ID certificate if you want to notarize the `.dmg` (not required for personal use)

## Install

```bash
git clone https://github.com/SylvainSouche/arvecinema.git
cd arvecinema
npm install
```

## Commands

Run `npm run help` at any time for a quick reference. Full details below.

### Development

```bash
npm run dev          # dev mode (hot reload via Vite)
npm run debug        # same + ARVE_DEBUG=1 (verbose logs, DevTools auto-open)
npm run build        # production build to out/ (main + preload + renderer)
npm run preview       # run the built app from out/ without rebuilding
```

### Code quality

```bash
npm run typecheck     # tsc --noEmit (type check without building)
npm run format        # format all source files with Prettier
npm run format:check  # verify formatting without writing (used in CI)
```

### Unit tests (vitest, ~1.9s, 212 tests)

```bash
npm run test          # run all unit tests once
npm run test:watch    # re-run tests on file change
npm run test:coverage # run tests + generate coverage report
```

Tests cover: date/time helpers, title normalization, SQLite cache CRUD,
i18n fallback chain, VF/VO detection, plugin registry + auto-discovery,
AlloCiné HTML parser (with real fixture).

### E2E tests (Playwright + Electron, ~60s)

```bash
npm run test:e2e         # launch real Electron app, run 7 smoke tests
npm run test:e2e:headed # same but show the app window (for debugging)
```

Tests cover: app launch, header rendering, cinema selector, filter bar,
view toggle, about panel, diagnostics panel.

On Linux, `scripts/run-e2e.sh` auto-starts Xvfb if no display is detected.
On macOS/Windows, the native display is used.

### Network record/replay

```bash
npm run record   # launch app, capture ALL HTTP traffic to
                 # test/fixtures/network-capture.json
                 # (close the app to save the fixture)

npm run replay   # run E2E tests using the recorded fixture
                 # (no network needed, fully deterministic)
```

The recorder intercepts **both** network paths:

- `fetchWithTimeout` (Node.js fetch — Wikidata, boxofficeapi, RT)
- `browserFetch` (hidden BrowserWindow — AlloCiné, cinevox, Cloudflare bypass)

The fixture is a simple JSON map: `"GET:https://url" → {status, body}`.
On replay, every fetch returns the recorded response — zero network calls,
deterministic results, works offline.

### Packaging

```bash
npm run package      # build + package for current platform (.dmg / .exe / AppImage)
npm run package:dir  # build + unpacked directory (faster, for testing the packaged app)
npm run package:dmg   # build + macOS .dmg only (arm64)
```

### Environment variables

| Variable              | Effect                                                                          |
| --------------------- | ------------------------------------------------------------------------------- |
| `ARVE_DEBUG=1`        | Verbose console logging + saves raw HTML responses to `userData/debug/`         |
| `ARVE_NO_CACHE=1`     | Bypass both cache tiers — every launch re-fetches from Wikidata + AlloCiné + RT |
| `ARVE_IMDB_GRAPHQL=1` | Re-enable the IMDB GraphQL batch path (disabled by default)                     |
| `ARVE_RECORD=path`    | Record all HTTP traffic to a JSON fixture file (used by `npm run record`)       |
| `ARVE_REPLAY=path`    | Replay recorded HTTP responses from a JSON fixture (used by `npm run replay`)   |

Combined example: `ARVE_DEBUG=1 ARVE_NO_CACHE=1 npm run dev`

Version bumping is explicit via `npm version <patch|minor|major>` (no auto-bump in scripts).

## Security

- **CSP** locked down in `index.html` — `default-src 'self'`, `script-src 'self'`, `connect-src 'self'`, no `unsafe-eval`, no remote `connect-src`
- **Preload**: `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`
- **Renderer navigation**: `will-navigate` blocks all remote origins AND restricts `file://` to the actual built `renderer/index.html` (path-compared, Windows drive-letter aware)
- **Window-open**: renderer-initiated window creation is denied on the main window and on any future `webContents`
- **Hidden `browserFetch` window** (used for Cloudflare bypass): explicit deny handlers for `setWindowOpenHandler`, `will-navigate` (deny all), `will-redirect` (same-registrable-domain allow-list only), plus `setPermissionRequestHandler` / `setPermissionCheckHandler` returning `false`
- **`tickets:open` IPC**: HTTPS-only URL validation via `new URL().protocol` check before `shell.openExternal`
- **Body-read timeout**: `readBodyWithTimeout` helper bounds the body read independently of headers timeout — prevents slow-trickle DoS
- **Single instance**: `app.requestSingleInstanceLock()` — second launch focuses the existing window instead of spawning a new one
- **Packaged menu**: full menu stripped in `app.isPackaged` so DevTools isn't exposed to end users
- **Known residual audit findings**: all in transitive dev-only deps (node-gyp, tar, extract-zip, esbuild, vite) — none reach production runtime. Awaiting upstream releases compatible with Electron 33.

## Architecture

```
src/
├── main/
│   ├── index.ts                 Electron main process (window lifecycle, IPC, security handlers)
│   ├── tz.ts                    Forces process.env.TZ = 'Europe/Paris' before any Date construction
│   ├── cinemas/
│   │   ├── registry.ts           Drop-in cinema registry (add one line)
│   │   ├── types.ts              CinemaAdapter interface + Movie/Showtime types
│   │   ├── boxOfficeApiAdapter   JSON API adapter (Mont-Blanc, Cluses, Bonneville)
│   │   ├── cineChateauAdapter    ⚠️ Sleeping backup — old HTML scraper for Bonneville (now uses boxOfficeApi)
│   │   └── cineVoxAdapter        HTML scraper (Chamonix, ISO-8859-1, URL-timestamp based)
│   └── ratings/
│       ├── ratingsEnricher.ts    Three-phase progressive enrichment (Wikidata IDs → IMDB dataset lookup → per-film AlloCiné/RT)
│       ├── cacheDb.ts             **Single SQLite cache** (`cache.db`) — `ids_cache` + `ratings_cache` + `imdb_ratings` + `meta` tables. Auto-migrates old JSON files.
│       ├── wikidataClient.ts     SPARQL batch + per-film title search (IDs only, with year disambiguation)
│       ├── allocineClient.ts      AlloCiné scraper (browserFetch, `rating-mdl nXX` parser)
│       ├── imdbDatasetClient.ts   **IMDB ratings via official dataset** — stored in shared `cache.db` `imdb_ratings` table (36h refresh, in-background)
│       ├── imdbClient.ts          ⚠️ Sleeping backup — per-film IMDB HTML scraper (browserFetch). Not imported by active code.
│       ├── imdbGraphqlClient.ts   ⚠️ Sleeping backup / dev probe — IMDB GraphQL batch. Not imported by active code.
│       ├── rottenTomatoesClient  RT scraper (pooledFetch, JSON-LD tomatometer)
│       └── browserFetch.ts        Hidden BrowserWindow (bypasses Cloudflare for AlloCiné, same-domain redirects only, ad-blocker)
├── preload/index.ts             contextBridge (narrow IPC surface — `cinemas:list`, `schedule:fetch`, `tickets:open`, `rating:updated`, `ratings:progress`, `network:activity`)
├── renderer/
│   ├── App.tsx                  Shell + filter pipeline + sort
│   ├── components/              14 React components (ErrorBoundary, DaySelector, CinemaSelector, DoubleRangeSlider, MovieCard, ShowtimeList, WeekGrid, FilterBar, CinemaStatusBanner, SortSelector, ViewToggle, ProgressBar, ExportButton, AboutPanel)
│   ├── types/index.ts           Re-exports shared types
│   └── api/cinemaApi.ts         IPC wrapper (typed)
└── shared/
    ├── types.ts                 Single source of truth (Movie, Showtime, CinemaInfo, etc.)
    ├── cinema.ts                Date/time/format helpers (timezone-safe via Intl with Europe/Paris)
    ├── i18n.ts                  All UI strings (fr/en)
    ├── userAgent.ts             Dynamic `ArveCinema/{version}` User-Agent
    ├── connectionPool.ts        Per-domain rate-limited fetch (serialized per host, 2s default delay)
    └── fetchWithTimeout.ts      AbortController-based fetch timeout + readBodyWithTimeout helper + TimeoutError
```

## Adding a cinema

Open `src/main/cinemas/registry.ts` and append:

```ts
{
  id: 'my-cinema',
  name: 'Ciné Example',
  city: 'Example',
  color: '#ff6600',
  adapter: createBoxOfficeApiAdapter('my-cinema', {
    baseUrl: 'https://www.example-cinema.fr',
    theaterId: 'PXXXX',
  }),
}
```

Two adapter factories are provided:

- `createBoxOfficeApiAdapter` — for gatsby-source-boxofficeapi sites (JSON API)
- `createCineChateauAdapter` / `createCineVoxAdapter` — for cotecine.fr sites (HTML scraping, ISO-8859-1 aware)

## Ratings pipeline

Three-phase progressive enrichment:

1. **Phase 1** (fast, parallel): Wikidata lookup by AlloCiné ID or title + year → resolves QID, IMDB ID, RT path, AlloCiné ID. UI shows source icons immediately, before any score is fetched.
2. **Phase 1.5** (instant): all movies with an IMDB ID are looked up in the local **SQLite database** (`cache.db`, table `imdb_ratings`, populated from IMDB's official public dataset `title.ratings.tsv.gz` — 1.71M rated titles, refreshed every 36h). Sync `SELECT ... WHERE tconst IN (...)` query — no network calls at request time. `rating:updated` IPC fires per-film as each result lands.
   - The SQLite DB lives at `~/Library/Application Support/ArveCinema/cache.db` (macOS) / `~/.config/ArveCinema/cache.db` (Linux) / `%APPDATA%\ArveCinema\cache.db` (Windows).
   - The `.tsv.gz` is downloaded to a temp file, parsed, inserted into SQLite in a transaction, then deleted — only the DB is kept on disk.
   - Refresh logic: on startup, check the `meta.last_update` row in the DB. If older than 36h (or DB empty), kick off a background refresh. **Does NOT block UI** — the app shows whatever's in the DB immediately, and re-emits `rating:updated` for any films whose ratings changed after the refresh completes.
3. **Phase 2** (slow, per-film, progressive): AlloCiné + Rotten Tomatoes scraping via `browserFetch` (hidden BrowserWindow with ad/tracker blocker). IMDB is NOT scraped — the dataset is the single source of truth.

Each source completion fires a `rating:updated` IPC event so the score appears progressively next to its icon in the UI. Failed sources surface a `❓` placeholder.

Cloudflare-protected sites (AlloCiné) are scraped via a hidden Electron `BrowserWindow` that runs real Chromium JS. Cloudflare's `cf_clearance` cookie is persisted in a per-domain partition so subsequent requests skip the challenge.

Storage in the user data dir:

- **`cache.db`** — single SQLite file containing all caches (see below)
- **In-flight dedup**: concurrent lookups for the same film share a single network request via `inflightIds` / `inflightRatings` Maps

### `cache.db` schema

| Table           | Keyed by                                                 | TTL       | Purpose                                                    |
| --------------- | -------------------------------------------------------- | --------- | ---------------------------------------------------------- |
| `ids_cache`     | `cache_key` (e.g. `allocine:55774` or `title:cars:2006`) | Permanent | Wikidata → IMDB/RT/AlloCiné ID resolution                  |
| `ratings_cache` | `qid`                                                    | 24h       | Scraped AlloCiné/RT scores per film                        |
| `imdb_ratings`  | `tconst`                                                 | 36h       | IMDB dataset (1.71M rated titles), refreshed in background |
| `meta`          | `key`                                                    | —         | Generic key/value (e.g. `imdb_dataset_last_update`)        |

Old JSON cache files (`ids-cache.json`, `ratings-cache.json`) and the old standalone `imdb-ratings.db` are auto-migrated to SQLite on first launch (see `cacheDb.migrateJsonCaches()`), then renamed to `.archived` so we don't re-import them.

## License

BSD 3-Clause — see [LICENSE](LICENSE).

## Attribution

**IMDB ratings** are sourced from IMDB's official public dataset
([`title.ratings.tsv.gz`](https://datasets.imdbws.com/)), used under IMDB's
non-commercial data license. Per the terms at
<https://help.imdb.com/article/imdb/general-information/can-i-use-imdb-data-in-my-software/G5JTRESSHJBBHTGX>:

> Information courtesy of IMDb (https://www.imdb.com). Used with permission.

The dataset is downloaded daily and cached locally; no scraping of imdb.com
is performed.
