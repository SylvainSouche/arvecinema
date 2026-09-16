# ArveCinema

Electron desktop app for cinema showtimes in the Arve Valley (Sallanches, Cluses, Bonneville, Chamonix).

Built with Electron 30 + React 18 + TypeScript + electron-vite. BSD-3-Clause licensed.

## Features

- **4 cinemas** via a modular adapter registry — add/remove a cinema in one line
- **Day view**: one card per film (deduplicated across cinemas), sorted by next screening / title / cinema
- **Week view**: swimlane grid with showtime chips positioned by real start/end time, middle-click drag to pan
- **Filters**: cinema multi-select, day picker, audio version (VF/VO), hour range (quarter-hour slider), title/director/actor search
- **Ratings**: progressive enrichment via Wikidata → AlloCiné (press + audience) + IMDB + Rotten Tomatoes (tomatometer)
- **Dark / light theme**, French / English UI
- **Offline cache**: Wikidata IDs cached permanently, ratings cached 24h

## Run

```bash
npm install
npm run dev          # dev mode (hot reload)
npm run debug        # dev mode + DevTools + verbose logs
npm run typecheck    # tsc --noEmit
npm run build        # production build
npm run package:dir  # .app folder (auto-bumps version)
npm run package:dmg  # .dmg installer (auto-bumps version)
```

## Architecture

```
src/
├── main/
│   ├── index.ts                 Electron main process
│   ├── tz.ts                    Forces process.env.TZ = 'Europe/Paris'
│   ├── cinemas/
│   │   ├── registry.ts           Drop-in cinema registry (add one line)
│   │   ├── types.ts              CinemaAdapter interface
│   │   ├── boxOfficeApiAdapter   JSON API adapter (Mont-Blanc, Cluses)
│   │   ├── cineChateauAdapter    HTML scraper (Bonneville)
│   │   └── cineVoxAdapter        HTML scraper (Chamonix, ISO-8859-1)
│   └── ratings/
│       ├── ratingsEnricher.ts    Two-phase progressive enrichment
│       ├── wikidataClient.ts     SPARQL + wbgetentities (IDs only)
│       ├── allocineClient.ts      AlloCiné scraper (browserFetch)
│       ├── imdbClient.ts          IMDB scraper (browserFetch)
│       ├── rottenTomatoesClient  RT scraper (pooledFetch)
│       └── browserFetch.ts        Hidden BrowserWindow (bypasses Cloudflare)
├── preload/index.ts             contextBridge (narrow IPC surface)
├── renderer/
│   ├── App.tsx                  Shell + filter pipeline + sort
│   ├── components/              12 React components
│   ├── types/index.ts           Re-exports shared types
│   └── api/cinemaApi.ts         IPC wrapper
└── shared/
    ├── types.ts                 Single source of truth (Movie, Showtime, etc.)
    ├── cinema.ts                Date/time/format helpers
    ├── i18n.ts                  All UI strings (fr/en)
    ├── connectionPool.ts        Per-domain rate-limited fetch
    └── fetchWithTimeout.ts      AbortController + TimeoutError
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
- `createCineChateauAdapter` / `createCineVoxAdapter` — for cotecine.fr sites (HTML scraping)

## Ratings pipeline

1. **Phase 1** (fast): Wikidata lookup by AlloCiné ID or title → resolves QID, IMDB ID, RT path, AlloCiné ID. UI shows source icons immediately.
2. **Phase 2** (progressive): Scrape AlloCiné + IMDB + RT in sequence. Each source sends a `rating:updated` IPC event as it completes — scores appear one by one.

Cloudflare-protected sites (IMDB, AlloCiné) are scraped via a hidden Electron BrowserWindow that runs real Chromium JS.

## License

BSD 3-Clause — see [LICENSE](LICENSE).
