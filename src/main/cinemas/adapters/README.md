# Cinema Adapters — Fully Drop-in Plugin System

This directory contains all cinema adapter plugins. Each plugin knows how to
fetch and parse the schedule from a specific type of cinema website
(boxofficeapi-powered sites, cotecine CMS sites, etc.).

Cinema instances (which cinema, what URL, what theaterId) live in
`src/main/cinemas/instances/` — one file per cinema, also auto-discovered.

## Architecture

```
src/main/cinemas/
├── registry.ts                ← Auto-discovers instances, instantiates plugins
├── types.ts                  ← CinemaAdapter contract + Cinema wrapper
├── adapters/                  ← Adapter TYPES (how to scrape a kind of site)
│   ├── plugin.ts              ← CinemaAdapterPlugin interface + helpers
│   ├── index.ts               ← Auto-discovers plugins via import.meta.glob
│   ├── boxOfficeApi.ts        ← Gatsby + gatsby-source-boxofficeapi stack
│   ├── cineVox.ts             ← cotecine CMS (cinemavox-chamonix.com)
│   ├── cineChateau.ts         ← cotecine CMS (sleeping backup)
│   └── examplePlugin.ts       ← Canary/template — proves auto-discovery
└── instances/                  ← Cinema INSTANCES (which cinema, what URL)
    ├── montBlanc.ts           ← Ciné Mont-Blanc (Sallanches)
    ├── cluses.ts              ← Ciné de Cluses (Cluses)
    ├── bonneville.ts          ← Ciné Château (Bonneville)
    ├── chamonix.ts            ← Cinéma Vox (Chamonix)
    └── _exampleInstance.ts    ← Canary/template — proves auto-discovery
```

## TRUE fully drop-in auto-discovery

Both layers are auto-discovered via Vite's `import.meta.glob()`:

| Layer            | Directory                     | What you drop                                        | Auto-discovered?                   |
| ---------------- | ----------------------------- | ---------------------------------------------------- | ---------------------------------- |
| Adapter TYPES    | `src/main/cinemas/adapters/`  | A `.ts` file exporting `CinemaAdapterPlugin` default | ✅ Yes — no edit to any other file |
| Cinema INSTANCES | `src/main/cinemas/instances/` | A `.ts` file exporting `CinemaInstance` default      | ✅ Yes — no edit to any other file |

The canary files (`examplePlugin.ts` + `_exampleInstance.ts`) are permanent
fixtures — the test suite (`test/main/cinemas/adapters/plugin.test.ts`)
asserts they're discoverable. If auto-discovery ever breaks, those tests fail.

> Release filtering: `_exampleInstance.ts` declares `testOnly: true`, so the
> registry registers the canary in `npm run dev` and unit tests, but skips it
> in bundled builds (`electron-vite build` → `import.meta.env.DEV === false`).
> End users never see it in the cinema list. A new real cinema must NOT set
> `testOnly` (or must set it to `false`).

## Adding a new cinema SITE (truly drop-in — no other file edits)

Drop a `.ts` file in `src/main/cinemas/instances/megève.ts`:

```typescript
import type { CinemaInstance } from '../adapters/plugin';

const cinema: CinemaInstance = {
  id: 'megève',
  name: 'Ciné Megève',
  city: 'Megève',
  color: '#f59e0b',
  adapter: {
    kind: 'boxofficeapi', // references an existing adapter plugin
    baseUrl: 'https://www.cinema-megève.fr',
    theaterId: 'P9999',
  },
};

export default cinema;
```

That's it — **no edit to `registry.ts`, `cinemas.config.json`, or any other file**.
Restart the app (or re-run the dev server) and the cinema appears.

> Tip: copy `instances/_exampleInstance.ts` to your new file as a starting point.

## Adding a new adapter TYPE (truly drop-in — no other file edits)

For a cinema site using a different CMS / scraping strategy:

1. **Create the plugin file** at `src/main/cinemas/adapters/myAdapter.ts`:

   ```typescript
   import type { CinemaAdapter } from '../types';
   import type { CinemaAdapterPlugin, CinemaConfig, ConfigValidationResult } from './plugin';
   import { requireString, mergeDefaults } from './plugin';

   const plugin: CinemaAdapterPlugin = {
     id: 'myadapter',
     displayName: 'My Custom Adapter',
     description: 'Scraper for cinema-foo.fr',

     defaultConfig: {
       schedulePath: '/schedule',
     },

     validateConfig(config: CinemaConfig): ConfigValidationResult {
       const errors: string[] = [];
       try {
         requireString(config, 'baseUrl');
       } catch (e) {
         errors.push(e instanceof Error ? e.message : String(e));
       }
       if (errors.length > 0) return { ok: false, errors };
       return { ok: true, config: mergeDefaults(config, plugin.defaultConfig) };
     },

     createAdapter(cinemaId: string, config: CinemaConfig): CinemaAdapter {
       const baseUrl = requireString(config, 'baseUrl');
       const schedulePath = (config.schedulePath as string) ?? '/schedule';

       return {
         async fetchSchedule(windowDays: number) {
           // ... fetch HTML / JSON, parse, return Movie[]
           return { availableDays: [], movies: [] };
         },
       };
     },
   };

   export default plugin;
   ```

2. **Use the plugin** in a cinema instance file (e.g. `instances/foo.ts`):

   ```typescript
   import type { CinemaInstance } from '../adapters/plugin';

   const cinema: CinemaInstance = {
     id: 'foo',
     name: 'Cinéma Foo',
     city: 'Foo City',
     color: '#abcdef',
     adapter: {
       kind: 'myadapter',
       baseUrl: 'https://www.cinema-foo.fr',
     },
   };

   export default cinema;
   ```

That's it — **no edit to `index.ts`, `registry.ts`, or any other file**. Both
the plugin and the cinema instance are auto-discovered at build time.

> Tip: copy `examplePlugin.ts` to `myAdapter.ts` as a starting point.

## Plugin contract

Each plugin implements the `CinemaAdapterPlugin` interface (see `plugin.ts`):

| Field                             | Required | Description                                                                                        |
| --------------------------------- | -------- | -------------------------------------------------------------------------------------------------- |
| `id`                              | yes      | Unique identifier (lowercase, alphanumeric + dashes). Used in cinema instance files' `kind` field. |
| `displayName`                     | yes      | Human-readable name (for diagnostics + future UI).                                                 |
| `description`                     | no       | One-line description of what sites this handles.                                                   |
| `defaultConfig`                   | no       | Default config values (shallow-merged with user config).                                           |
| `validateConfig(config)`          | no       | Validates the config + applies defaults. Returns `{ ok, config }` or `{ ok: false, errors }`.      |
| `createAdapter(cinemaId, config)` | yes      | Factory function returning a `CinemaAdapter` instance.                                             |

The returned `CinemaAdapter` must implement:

```typescript
interface CinemaAdapter {
  fetchSchedule(windowDays: number): Promise<{
    availableDays: string[]; // YYYY-MM-DD list, sorted
    movies: Movie[]; // Movies with showtimes
  }>;
}
```

It may throw:

- `ScraperSchemaChangedError` — page structure changed, parser needs updating
- `TimeoutError` — request exceeded the timeout (from `fetchWithTimeout`)
- Any other `Error` — caught by the IPC handler and reported as `'http-error'`

## Cinema instance contract

Each cinema instance file exports a `CinemaInstance` default:

| Field     | Required | Description                                                           |
| --------- | -------- | --------------------------------------------------------------------- |
| `id`      | yes      | Stable slug (e.g. "mont-blanc"). Used in IPC payloads + filter state. |
| `name`    | yes      | Display name (e.g. "Ciné Mont-Blanc").                                |
| `city`    | yes      | City (e.g. "Sallanches").                                             |
| `color`   | yes      | Hex color for the cinema badge on each showtime chip.                 |
| `adapter` | yes      | Config object: `{ kind: string, ...pluginSpecificConfig }`.           |

## Plugin helpers

The `plugin.ts` module exports helpers for plugin authors:

- `requireString(config, key)` — assert config value is a non-empty string.
- `optionalString(config, key, fallback)` — get config value or fallback.
- `mergeDefaults(config, defaults)` — shallow-merge defaults with user config.

## Existing plugins

| Plugin id      | File               | Description                                                                 |
| -------------- | ------------------ | --------------------------------------------------------------------------- |
| `boxofficeapi` | `boxOfficeApi.ts`  | Gatsby + gatsby-source-boxofficeapi stack (Mont-Blanc, Cluses, Bonneville). |
| `cinevox`      | `cineVox.ts`       | cotecine CMS with ISO-8859-1 + booking URL timestamp (Chamonix Vox).        |
| `cinechateau`  | `cineChateau.ts`   | cotecine CMS (sleeping backup for cinechateau.fr).                          |
| `example`      | `examplePlugin.ts` | Canary/template — proves auto-discovery works. Copy-paste starting point.   |

## Existing cinema instances

| Cinema id        | File                            | City                              |
| ---------------- | ------------------------------- | --------------------------------- |
| `mont-blanc`     | `instances/montBlanc.ts`        | Sallanches                        |
| `cluses`         | `instances/cluses.ts`           | Cluses                            |
| `bonneville`     | `instances/bonneville.ts`       | Bonneville                        |
| `chamonix`       | `instances/chamonix.ts`         | Chamonix                          |
| `example-cinema` | `instances/_exampleInstance.ts` | Nowhere (canary — `testOnly` true, excluded from release builds) |

## Runtime custom instances (`custom-cinemas.json`)

Beyond bundled `.ts` instances, the registry can register **runtime**
cinemas from a JSON file the user controls — works in the packaged app
with no repackage/rebuild required:

| | |
|---|---|
| File location | `userData/custom-cinemas.json` (same dir as `cache.db`; use "Open logs" in the About panel to find it) |
| Loaded | at startup, and via the `cinemas:reload-custom` IPC (for a future settings UI) |
| Allowed content | **JSON only** — no code execution, so it's safe for packaged builds; adapter `kind` must reference an already-bundled plugin |

Schema — same shape as bundled instances:

```json
{
  "cinemas": [
    {
      "id": "megève",
      "name": "Cinéma Megève",
      "city": "Megève",
      "color": "#f59e0b",
      "adapter": { "kind": "boxofficeapi", "baseUrl": "https://www.cinema-megeve.fr", "theaterId": "P9999" }
    }
  ]
}
```

Semantics:

- **The file mirrors the custom registry**: a reload replaces the entire
  custom set with the file's valid entries — removing an entry removes the
  cinema on the next load/startup.
- **Corruption guard**: a missing, malformed-JSON or wrong-shape file keeps
  the previous custom set intact and starts clean (never wipes).
- **Validation parity**: entries pass the same shape checks + plugin
  `validateConfig` as bundled instances. Invalid entries are skipped and
  reported (logs + structured errors); valid entries still register.
- **Namespace protection**: a custom id colliding with a bundled id is
  rejected — users cannot hijack builtin cinemas. Duplicate ids within the
  file register only the first occurrence.

Unit tests: `test/main/cinemas/customRegistry.test.ts` (17 cases). E2E:
`test/e2e/custom-cinema.e2e.ts`. Still future: a settings UI reading/writing
this file instead of manual editing.

## Testing

Plugin unit tests can mock `browserFetch` / `fetchWithTimeout` to feed in
captured HTML/JSON, then assert the output `Movie[]` shape. See TODO.md
"Testing" section for the planned Playwright fixture capture workflow.

The auto-discovery canaries (`examplePlugin.ts` + `_exampleInstance.ts`) are
covered by `test/main/cinemas/adapters/plugin.test.ts` — if either ever
stops being discovered, the "TRUE drop-in" tests fail. The tests also cover
the release-build filter: with `includeTestOnly: false` (what a bundled
build does), the canary is skipped while the 4 real cinemas still load.
