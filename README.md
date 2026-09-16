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
git clone https://github.com/sylvain/arvecinema.git
cd arvecinema
npm install
```

## Run

```bash
npm run dev          # dev mode (hot reload)
npm run debug        # dev mode + DevTools + verbose logs (ARVE_DEBUG=1)
npm run typecheck    # tsc --noEmit
npm run build        # production build (electron-vite)
npm run package:dir  # .app / unpacked folder
npm run package:dmg  # macOS .dmg installer
npm run package:zip  # macOS .zip (for notarization upload)
npm run format       # prettier write
npm run format:check # prettier check (CI)
```

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
│   │   ├── boxOfficeApiAdapter   JSON API adapter (Mont-Blanc, Cluses)
│   │   ├── cineChateauAdapter    HTML scraper (Bonneville, ISO-8859-1 fallback)
│   │   └── cineVoxAdapter        HTML scraper (Chamonix, ISO-8859-1 fallback, URL-timestamp based)
│   └── ratings/
│       ├── ratingsEnricher.ts    Two-phase progressive enrichment + in-flight dedup
│       ├── RatingProvider.ts     Per-source rating fetch orchestration
│       ├── wikidataClient.ts     SPARQL + wbgetentities (IDs only, with year disambiguation)
│       ├── allocineClient.ts      AlloCiné scraper (browserFetch, `rating-mdl nXX` parser)
│       ├── imdbClient.ts          IMDB scraper (browserFetch, JSON-LD parser)
│       ├── rottenTomatoesClient  RT scraper (pooledFetch, JSON-LD tomatometer)
│       └── browserFetch.ts        Hidden BrowserWindow (bypasses Cloudflare, same-domain redirects only)
├── preload/index.ts             contextBridge (narrow IPC surface — only `cinemas:list`, `schedule:fetch`, `tickets:open`, `rating:updated`)
├── renderer/
│   ├── App.tsx                  Shell + filter pipeline + sort
│   ├── components/              11 React components (ErrorBoundary, DaySelector, CinemaSelector, DoubleRangeSlider, MovieCard, ShowtimeList, WeekGrid, FilterBar, CinemaStatusBanner, SortSelector, ViewToggle)
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

1. **Phase 1** (fast): Wikidata lookup by AlloCiné ID or title + year → resolves QID, IMDB ID, RT path, AlloCiné ID. UI shows source icons immediately.
2. **Phase 2** (progressive): Scrape AlloCiné + IMDB + RT in sequence. Each source sends a `rating:updated` IPC event as it completes — scores appear one by one. Failed sources surface a `❓` placeholder.

Cloudflare-protected sites (IMDB, AlloCiné) are scraped via a hidden Electron `BrowserWindow` that runs real Chromium JS. Cloudflare's `cf_clearance` cookie is persisted in a per-domain partition so subsequent requests skip the challenge.

Two cache tiers in the user data dir:
- **IDs cache** (Wikidata → IMDB/RT/AlloCiné IDs): permanent, no TTL
- **Ratings cache** (scraped scores): 24h TTL

In-flight deduplication: concurrent lookups for the same film share a single network request via `inflightIds` / `inflightRatings` Maps.

## License

BSD 3-Clause — see [LICENSE](LICENSE).
