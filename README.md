# ArveCinema

Electron desktop app for cinema showtimes in the Arve Valley (Sallanches, Cluses, Bonneville, Chamonix).

Built with Electron 33 + React 18 + TypeScript + electron-vite. BSD-3-Clause licensed.

## Features

- **4 cinemas** via a drop-in plugin system — add a cinema by dropping a `.ts` file, no code edits needed
- **Day view**: one card per film (deduplicated across cinemas), sorted by next screening / title / cinema
- **Week view**: swimlane grid with showtime chips positioned by real start/end time, middle-click drag to pan
- **Filters**: cinema multi-select, day picker, audio version (VF/VO), hour range (quarter-hour slider), title/director/actor search
- **Ratings**: progressive enrichment via Wikidata → AlloCiné (press + audience) + IMDB + Rotten Tomatoes (tomatometer)
- **Diagnostics panel**: per-cinema health, per-source counts, blocked films, "Copy diagnostics" for bug reports
- **Dark / light theme**, French / English UI
- **Offline cache**: Wikidata IDs cached permanently (unless incomplete), ratings cached 24h

## Prerequisites

- **Node.js** ≥ 18.0 (required by Electron 33)
- **npm** ≥ 9 (or compatible pnpm/yarn)
- **Git** (to clone the repo)
- **Network access** on first launch (Wikidata + AlloCiné/IMDB/RT are fetched lazily, then cached)
- **Linux only**: `libnss3`, `libatk1.0-0`, `libatk-bridge2.0-0`, `libgbm1`, `libgtk-3-0` (Electron runtime deps)
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

### Unit tests (vitest, ~2s, 262 tests)

```bash
npm run test          # run all unit tests once
npm run test:watch    # re-run tests on file change
npm run test:coverage # run tests + generate coverage report
```

Tests cover: date/time helpers, title normalization, title cleaning rules
(FR + EN patterns), SQLite cache CRUD, i18n fallback chain, VF/VO detection,
plugin registry + auto-discovery, AlloCiné HTML parser (with real fixture).

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

## Security

- **CSP** locked down in `index.html` — `default-src 'self'`, `script-src 'self'`, `connect-src 'self'`, no `unsafe-eval`, no remote `connect-src`
- **Preload**: `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`
- **Renderer navigation**: `will-navigate` blocks all remote origins AND restricts `file://` to the actual built `renderer/index.html`
- **Window-open**: renderer-initiated window creation is denied on the main window and on any future `webContents`
- **Hidden `browserFetch` window** (used for Cloudflare bypass): explicit deny handlers for `setWindowOpenHandler`, `will-navigate`, `will-redirect`, plus `setPermissionRequestHandler` / `setPermissionCheckHandler` returning `false`
- **`tickets:open` IPC**: HTTPS-only URL validation via `new URL().protocol` check before `shell.openExternal`
- **Single instance**: `app.requestSingleInstanceLock()` — second launch focuses the existing window
- **Packaged menu**: full menu stripped in `app.isPackaged` so DevTools isn't exposed to end users

## Architecture

```
src/
├── main/
│   ├── index.ts                 Electron main process (window lifecycle, IPC, security, shutdown)
│   ├── tz.ts                    Forces process.env.TZ = 'Europe/Paris' before any Date construction
│   ├── cinemas/
│   │   ├── registry.ts           Auto-discovers cinema instances via import.meta.glob()
│   │   ├── types.ts              CinemaAdapter interface + Movie/Showtime types
│   │   ├── adapters/             Drop-in adapter plugins (auto-discovered)
│   │   │   ├── plugin.ts         CinemaAdapterPlugin interface + helpers
│   │   │   ├── index.ts          Auto-discovery via import.meta.glob()
│   │   │   ├── boxOfficeApi.ts   Gatsby + boxofficeapi (Mont-Blanc, Cluses, Bonneville)
│   │   │   ├── cineVox.ts        cotecine CMS HTML scraper (Chamonix)
│   │   │   ├── cineChateau.ts    cotecine CMS (sleeping backup)
│   │   │   └── examplePlugin.ts  Canary/template — proves auto-discovery works
│   │   └── instances/           Cinema instances (auto-discovered, one file per cinema)
│   │       ├── montBlanc.ts      Ciné Mont-Blanc (Sallanches)
│   │       ├── cluses.ts         Ciné de Cluses (Cluses)
│   │       ├── bonneville.ts     Ciné Château (Bonneville)
│   │       ├── chamonix.ts       Cinéma Vox (Chamonix)
│   │       └── _exampleInstance.ts  Canary/template
│   └── ratings/
│       ├── ratingsEnricher.ts    Orchestrator (154 lines) — Phase 0 → 1a → 1b → 1.5 → 2
│       ├── idResolver.ts         Wikidata ID resolution + cache management
│       ├── ratingsFetcher.ts     AlloCiné + RT + IMDB scraping + retry logic
│       ├── cacheDb.ts            Single SQLite cache (ids_cache + ratings_cache + imdb_ratings + meta)
│       ├── wikidataClient.ts     MediaWiki search API (haswbstatement + wbgetentities) — NO SPARQL
│       ├── allocineClient.ts     AlloCiné scraper (pooledFetch first, browserFetch fallback for Cloudflare)
│       ├── imdbDatasetClient.ts  IMDB ratings via official dataset (36h refresh, in-background)
│       ├── rottenTomatoesClient RT scraper (pooledFetch, JSON-LD tomatometer)
│       ├── browserFetch.ts       Hidden BrowserWindow pool (per-domain reuse, Cloudflare bypass, ad-blocker)
│       ├── networkRecorder.ts    Record/replay all HTTP traffic for deterministic tests
│       ├── logger.ts             Pluggable logging (console + memory + file dispatchers)
│       ├── moduleLoggers.ts      Per-component logger instances
│       ├── networkActivity.ts    Tracks in-flight requests for UI spinner
│       └── shutdown.ts          Cancellation flag for background workers
├── preload/index.ts             contextBridge (narrow IPC surface)
├── renderer/
│   ├── App.tsx                  Shell + filter pipeline + sort + dedup (both views)
│   ├── hooks/                   Custom React hooks (useTheme, useSchedule, useRatingsIPC, useRetryFailedLookups)
│   ├── components/              15 React components
│   ├── styles/                  Design tokens (tokens.ts) + shared presets (components.ts)
│   └── api/cinemaApi.ts         IPC wrapper (typed)
└── shared/
    ├── types.ts                 Single source of truth (Movie, Showtime, CinemaInfo, etc.)
    ├── cinema.ts                Date/time/format helpers + dedupTitle()
    ├── i18n.ts                  All UI strings (fr/en) — 102 keys, fallback chain, tFmt, formatDecimal
    ├── titleRules/              Systematic title-cleaning rules (fr.ts + en.ts, 44 patterns)
    ├── userAgent.ts             `ArveCinema/{version} (https://github.com/SylvainSouche/arvecinema)`
    ├── connectionPool.ts        Per-domain rate-limited fetch (serialized per host, 2s default delay)
    └── fetchWithTimeout.ts      AbortController-based fetch timeout + record/replay wiring
```

## Adding a cinema

**Using an existing adapter type** (e.g. another boxofficeapi site) — drop a file in `instances/`:

```typescript
// src/main/cinemas/instances/megeve.ts
import type { CinemaInstance } from '../adapters/plugin';

const cinema: CinemaInstance = {
  id: 'megève',
  name: 'Ciné Megève',
  city: 'Megève',
  color: '#f59e0b',
  adapter: {
    kind: 'boxofficeapi',
    baseUrl: 'https://www.cinema-megève.fr',
    theaterId: 'P9999',
  },
};

export default cinema;
```

No other file needs editing. Restart the app and the cinema appears.

**Adding a new adapter type** — drop a file in `adapters/`:

```typescript
// src/main/cinemas/adapters/myAdapter.ts
import type { CinemaAdapter } from '../types';
import type { CinemaAdapterPlugin, CinemaConfig } from './plugin';

const plugin: CinemaAdapterPlugin = {
  id: 'myadapter',
  displayName: 'My Custom Adapter',
  // ...validateConfig, createAdapter
};

export default plugin;
```

Then reference it from a cinema instance file with `adapter: { kind: 'myadapter', ... }`.
See `src/main/cinemas/adapters/README.md` for the full contract.

## Ratings pipeline

Five-phase progressive enrichment:

1. **Phase 0** (instant, SQLite): apply cached Wikidata IDs + cached ratings (24h TTL).
2. **Phase 1a** (fast, sequential): batch Wikidata lookup by AlloCiné ID via MediaWiki search API (`haswbstatement:P1265=`). No SPARQL — 10× faster, no timeouts.
3. **Phase 1b** (per-film, fallback): Wikidata title search for films without AlloCiné IDs. Uses `wbsearchentities` + `wbgetentities`. Title cleaning rules strip avant-première/extended/director's cut/etc. before searching. Retry with original title if cleaned search yields nothing.
4. **Phase 1.5** (instant, SQLite): batch IMDB dataset lookup — all films with an IMDB ID are looked up in the local SQLite database (1.71M rated titles, refreshed every 36h in background).
5. **Phase 2** (slow, per-film, progressive): AlloCiné + Rotten Tomatoes scraping. AlloCiné uses `pooledFetch` (raw HTML, ~50 KB) with `browserFetch` fallback for Cloudflare. RT uses `pooledFetch`.

Each source completion fires a `rating:updated` IPC event so the score appears progressively.
Failed sources show a red ⚠ badge with the error message. A ⚡ retry button appears in the header when blocked sources exist.

### Wikidata

- Uses the **MediaWiki Action API** (`www.wikidata.org/w/api.php`), NOT SPARQL
- `haswbstatement:P1265=<allocineId>` search to find QIDs by property value
- `wbgetentities` batch fetch (up to 50 IDs per call) for IMDB/RT/TMDB IDs
- `wbsearchentities` for title-based fallback search
- Sequential calls with 200ms delay to respect Wikimedia rate limits
- User-Agent includes GitHub URL per [Wikimedia UA policy](https://meta.wikimedia.org/wiki/User-Agent_policy)
- Entities with no external IDs are NOT cached (re-checked each launch until IDs appear)

### Title cleaning

Systematic rules in `src/shared/titleRules/` strip cinema-event labels before Wikidata search and movie deduplication:

- **French**: avant-première, soirée spéciale, séance spéciale, événement spécial, exclusivité, version longue/courte/intégrale/restaurée, copie restaurée, partie N, metropolitan opera, opéra de Paris, bastille, concert, live, en direct, retransmission, captation
- **English**: advance screening, preview, special screening, exclusive, limited engagement, one night only, extended, extended cut/edition, remastered, director's cut, final cut, ultimate edition, uncut, unrated, IMAX, 3D, 4K, part N, met opera, live concert, in theaters, broadcast/streaming

If the cleaned title yields no results, retries with the original title (some films genuinely have "Extended" in their name).

### `cache.db` schema

| Table           | Keyed by                                                 | TTL        | Purpose                                                    |
| --------------- | -------------------------------------------------------- | ---------- | ---------------------------------------------------------- |
| `ids_cache`     | `cache_key` (e.g. `allocine:55774` or `title:cars:2006`) | Permanent* | Wikidata → IMDB/RT/AlloCiné ID resolution                  |
| `ratings_cache` | `qid`                                                    | 24h        | Scraped AlloCiné/RT scores per film                        |
| `imdb_ratings`  | `tconst`                                                 | 36h        | IMDB dataset (1.71M rated titles), refreshed in background |
| `meta`          | `key`                                                    | —          | Generic key/value (e.g. `imdb_dataset_last_update`)        |

\* Only cached if the Wikidata entity has at least one external ID (IMDB/RT/AlloCiné). Entities with no IDs are re-checked each launch.

The SQLite DB lives at `~/Library/Application Support/ArveCinema/cache.db` (macOS) / `~/.config/ArveCinema/cache.db` (Linux) / `%APPDATA%\ArveCinema\cache.db` (Windows).

## Diagnostics

Open ℹ️ → 🩺 Diagnostics tab to see:

- Per-cinema health (✅/⚠️/❌ + error messages)
- Per-rating-source counts (ok/blocked/absent/pending)
- Blocked films list with their specific error messages
- "Copy diagnostics" button — copies a structured report to clipboard for GitHub issues
- "Report issue" button — opens GitHub issues page

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
