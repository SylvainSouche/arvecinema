# Ciné Mont Blanc — Electron app

Electron 30 + React 18 + TypeScript + electron-vite.

## Run

```bash
npm install
npm run dev        # dev mode (hot reload)
npm run build      # production build → out/
npm run preview    # preview production build
npm run typecheck  # tsc --noEmit
```

## Package as a macOS app

```bash
# Quick .app folder — no DMG, no code signing. Fastest way to verify the icon
# and bundle structure. Output: dist/mac-arm64/Ciné Mont Blanc.app
npm run package:dir

# Both .dmg installer AND .zip (for arm64 + x64 universal distribution)
npm run package

# Just the .dmg installer
npm run package:dmg
```

**Outputs** end up in `dist/`:
- `dist/mac-arm64/Ciné Mont Blanc.app` — Apple Silicon
- `dist/mac-x64/Ciné Mont Blanc.app` — Intel
- `dist/Ciné Mont Blanc-1.0.0-arm64.dmg` — drag-to-Applications installer
- `dist/Ciné Mont Blanc-1.0.0-mac.zip` — for notarization / Sparkle updates

### Open the .app

```bash
open "dist/mac-arm64/Ciné Mont Blanc.app"
```

### Code signing & notarization (optional, for distribution)

The default config uses **ad-hoc signing** (no Developer ID certificate needed). The app will run on your own Mac, but Gatekeeper will warn other users. To distribute publicly:

1. Be a member of the Apple Developer Program
2. Export your Developer ID Application certificate
3. Add to `package.json`:
   ```json
   "mac": {
     "identity": "Developer ID Application: Your Name (TEAMID)",
     "notarize": {
       "teamId": "TEAMID"
     }
   }
   ```
4. Set env vars `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`
5. `npm run package` — electron-builder will sign + notarize automatically

### Architecture notes

- Default builds **both `arm64` and `x64`** (universal-ish, but as two separate DMGs)
- On an Apple Silicon Mac, the `arm64` build is ~2× faster to launch
- To build only for your host architecture: `electron-builder --mac dmg --arm64`
- For a true single universal binary: change `arch` to `["universal"]` (slower build, larger file, but one DMG for everyone)

## What it does

- Fetches a 14-day schedule window from the Ciné Mont Blanc (Sallanches) public API
- **Batched movie metadata fetch** via the correct `/movies?ids=A&ids=B&ids=C` endpoint
  (the previous `/movie?id=` endpoint returned HTML and silently dropped title/poster/cast/director)
- Day selector at the top lets you switch between available screening days
- One-row-per-movie layout: poster on the left, big bold title + VF/VO badges + genres/runtime,
  then direction and cast below, then showtimes
- Filter by audio version (Tous / VF / VO) and time range

## Structure

```
src/
├── main/index.ts           Electron main: schedule + batched movie metadata fetch
├── preload/index.ts        contextBridge → window.electronAPI
└── renderer/
    ├── index.html          Entry HTML (CSP-locked)
    ├── index.tsx           React root
    ├── App.tsx             App shell + day + filter state
    ├── api/cinemaApi.ts    Wrapper over window.electronAPI.fetchSchedule
    ├── types/index.ts      Movie / Showtime / ScheduleResponse + shared VF/VO helpers
    └── components/
        ├── DaySelector.tsx   Horizontal day picker
        ├── FilterBar.tsx     VF/VO + hour range
        ├── MovieCard.tsx     One-row layout
        └── ShowtimeList.tsx  Time chips + ticketing links
```

## API notes

The cinema exposes a Gatsby-source-boxofficeapi backend:

| Endpoint | Purpose |
|---|---|
| `GET /api/gatsby-source-boxofficeapi/schedule?from=ISO&to=ISO&theaters={"id":"P1798","timeZone":"Europe/Paris"}` | Returns `{ P1798: { schedule, showtimesDates, moviesTags } }` where `showtimesDates` is the list of available screening days |
| `GET /api/gatsby-source-boxofficeapi/movies?ids=A&ids=B&...` | Returns an array of movie objects (`title`, `poster`, `casting[]`, `direction[]`, `synopsis`, `genres`, `release`, `runtime`) |

## Key design choices

- **`main` field = `./out/main/index.js`** — matches electron-vite's default output convention (`src/main/index.ts` → `out/main/index.js`). Renaming source files from `main.ts` / `preload.ts` to `index.ts` was the fix for the `No electron app entry file found` error.
- **`process.env.TZ = 'Europe/Paris'`** is set at the very top of the main process so all `Date` math (day window, showtime hour, day key) operates in Paris time, regardless of the host machine's timezone.
- **Showtime hours and days** are parsed via `new Date(time).getHours()` and a `parisDay()` helper — never by string-slicing the ISO (which would yield UTC values).
- **Movie metadata is fetched in one batched request** instead of N per-movie requests, fixing the previous "Film {id} + no poster + no cast" issue and making startup much faster.
- **VF/VO detection is centralized** in `src/renderer/types/index.ts` (`isVFShowtime`, `isVOShowtime`, `showtimeVersion`) and mirrored in the main process.
- **CSP** is set in `index.html` to allow inline styles + posters from any https CDN, while restricting script execution to `'self'`.
- **`sandbox: true`** in `webPreferences` and **`contextIsolation: true`** for a hardened preload boundary.
