# Testing Strategy — ArveCinema

## Overview

ArveCinema has **6 test layers**, each catching different failure modes. No single layer is sufficient — they're complementary. This document maps each layer to what it tests, what it doesn't, and what failure modes it catches.

## Test layers

```
┌─────────────────────────────────────────────────────────────────────────┐
│ Layer 1: Unit tests (vitest)                                           │
│   Pure function correctness — date helpers, normalize, cacheDb CRUD   │
│   200 tests, 1.6s                                                     │
├─────────────────────────────────────────────────────────────────────────┤
│ Layer 2: Query snapshot tests (vitest)                                │
│   SPARQL query strings + GraphQL hashes — catches accidental changes  │
│   Planned — not yet implemented                                       │
├─────────────────────────────────────────────────────────────────────────┤
│ Layer 3: Parser contract tests (vitest)                               │
│   Feed known-good HTML/JSON fixtures to parsers, assert output       │
│   Planned — not yet implemented                                       │
├─────────────────────────────────────────────────────────────────────────┤
│ Layer 4: HAR replay tests (Playwright + Electron)                    │
│   Replay recorded network responses through the full pipeline         │
│   Planned (Phase 2) — needs HAR recording from user                  │
├───────────────────────────────────────────────────────────────────────┤
│ Layer 5: E2E smoke tests (Playwright + Electron)                     │
│   Launch built app, verify UI renders, click buttons                 │
│   6 tests, 59s — implemented                                         │
├───────────────────────────────────────────────────────────────────────┤
│ Layer 6: Live smoke tests (opt-in, manual)                           │
│   Hit real endpoints (Wikidata, cinema sites) — catches schema drift │
│   Planned — marked test.skip() by default                            │
└─────────────────────────────────────────────────────────────────────────┘
```

## Failure mode → test coverage matrix

| Failure mode                                      | L1 Unit | L2 Query | L3 Parser | L4 HAR | L5 E2E | L6 Live | User feedback                                           |
| ------------------------------------------------- | ------- | -------- | --------- | ------ | ------ | ------- | ------------------------------------------------------- |
| **Cinema HTML redesign** (site changes structure) | ❌      | ❌       | ❌        | ❌     | ❌     | ✅      | `CinemaStatusBanner` → "format du site modifié"         |
| **Cloudflare added** to cinema site               | ❌      | ❌       | ❌        | ❌     | ❌     | ✅      | `CinemaStatusBanner` → "délai dépassé" or "erreur HTTP" |
| **Cinema server down** (5xx/timeout)              | ❌      | ❌       | ❌        | ❌     | ❌     | ✅      | `CinemaStatusBanner` → "erreur HTTP"                    |
| **AlloCiné HTML changes** (rating CSS class)      | ❌      | ❌       | ✅        | ✅     | ❌     | ✅      | `StatusBadge` → red ⚠ + raw error message               |
| **RT HTML changes** (tomatometer selector)        | ❌      | ❌       | ✅        | ✅     | ❌     | ✅      | `StatusBadge` → red ⚠ + raw error message               |
| **Wikidata SPARQL schema change**                 | ❌      | ❌       | ❌        | ❌     | ❌     | ✅      | No badges appear (silent failure)                       |
| **Wikidata property renamed** (P345 → P344)       | ❌      | ✅       | ❌        | ❌     | ❌     | ✅      | No badges appear (silent failure)                       |
| **IMDB dataset format change** (TSV columns)      | ❌      | ❌       | ❌        | ❌     | ❌     | ✅      | IMDB badges show "absent"                               |
| **IMDB dataset unavailable** (download fails)     | ❌      | ❌       | ❌        | ❌     | ❌     | ✅      | Stale IMDB ratings (24h+ old cache)                     |
| **Cloudflare challenge changes** (challenge.js)   | ❌      | ❌       | ❌        | ❌     | ❌     | ✅      | All sources show "blocked" + Retry button appears       |
| **Query string modified** (accidental code edit)  | ❌      | ✅       | ❌        | ❌     | ❌     | ❌      | Wrong/missing data (silent)                             |
| **Parser refactor breaks** extraction             | ✅      | ❌       | ✅        | ✅     | ❌     | ❌      | No ratings for affected source                          |
| **Cache schema migration** breaks                 | ✅      | ❌       | ❌        | ❌     | ❌     | ❌      | Lost cache (re-fetches everything)                      |
| **IPC handler changes** break renderer comms      | ❌      | ❌       | ❌        | ❌     | ✅     | ❌      | UI blank or stuck on "Loading…"                         |
| **i18n key missing** (translation gap)            | ✅      | ❌       | ❌        | ❌     | ❌     | ❌      | Key string shown instead of translation                 |

## What each layer catches + misses

### Layer 1: Unit tests (vitest)

**Files:** `test/shared/*.test.ts`, `test/main/ratings/*.test.ts`
**Coverage:** Pure functions — date/time helpers, normalize, cacheDb CRUD, i18n, VF/VO detection, title coherence, plugin registry.
**Catches:** Logic bugs in pure functions, regressions in date parsing, cache UPSERT behavior, title normalization edge cases.
**Misses:** Network behavior, HTML parsing, IPC flows, UI rendering, query correctness.
**Speed:** 1.6s (200 tests).
**When to run:** Every PR (CI), every save (watch mode).

### Layer 2: Query snapshot tests (planned)

**Files:** `test/main/ratings/wikidataClient.test.ts`, `test/main/ratings/imdbGraphqlClient.test.ts`
**Coverage:** SPARQL query strings + GraphQL persisted query hashes.
**Catches:** Accidental query modifications (someone changes `wdt:P345` to `wdt:P344`), hash drift, query parameter changes.
**Misses:** Whether the query is actually valid (only a live endpoint can tell), whether the response shape has changed.
**Speed:** <1s (string comparison).
**When to run:** Every PR (CI).
**Key insight:** The snapshot diff makes changes visible in code review — the reviewer sees "you changed the SPARQL query, is that intentional?"

### Layer 3: Parser contract tests (planned)

**Files:** `test/main/ratings/allocineClient.test.ts`, `test/main/ratings/rottenTomatoesClient.test.ts`, `test/main/cinemas/adapters/*.test.ts`
**Coverage:** Parser functions (`parseAllocineHtml`, `parseRtHtml`, `boxOfficeApiAdapter`) fed known-good HTML/JSON fixtures.
**Catches:** Parser regressions from refactoring, CSS selector breakage, JSON shape changes.
**Misses:** Query correctness (the parser receives whatever HTML we give it), endpoint availability.
**Speed:** <1s per fixture.
**When to run:** Every PR (CI).
**Key insight:** Fixtures are small snippets (10-50 KB), not full page dumps. They focus on the specific HTML/JSON structure the parser cares about.

### Layer 4: HAR replay tests (planned — needs user recording)

**Files:** `test/e2e/har-*.e2e.ts`
**Coverage:** Full pipeline replay — recorded network responses go through the real fetch → parse → cache → enrich pipeline.
**Catches:** Integration bugs between fetch + parse + cache, regressions in the full pipeline, response format drift (if HAR is updated).
**Misses:** Query correctness (the HAR contains whatever the query returned when recorded), endpoint availability changes.
**Speed:** ~10s per HAR (includes Electron startup).
**When to run:** Every PR (CI), once HAR files are recorded.
**Key insight:** HAR replay is the ONLY layer that tests the full pipeline end-to-end with real response shapes. But it's frozen in time — it tests "does our code still handle the response shape we recorded?" not "does the endpoint still return that shape?"

### Layer 5: E2E smoke tests (implemented)

**Files:** `test/e2e/smoke.e2e.ts`
**Coverage:** App launches, UI renders, buttons work, about panel opens.
**Catches:** Build breakage, renderer crash, IPC handler missing, missing dependencies.
**Misses:** Data correctness, network behavior, parser logic.
**Speed:** 59s (6 tests, each launches a fresh Electron).
**When to run:** Every PR (CI), or manually via `npm run test:e2e`.

### Layer 6: Live smoke tests (planned — opt-in)

**Files:** `test/e2e/live-*.e2e.ts` (marked `test.skip()` by default)
**Coverage:** Real network calls to Wikidata, cinema sites, IMDB dataset endpoint.
**Catches:** Endpoint schema changes, property renames, Cloudflare challenge changes, site redesigns.
**Misses:** Nothing — this is ground truth. But it's slow, network-dependent, and can false-fail on transient issues.
**Speed:** 30-120s per endpoint.
**When to run:** Manually before releases (`npm run test:e2e:live`), or when a user reports an issue.
**Key insight:** This is the canary — if users report "ratings stopped working", run this to pinpoint which endpoint changed.

## The discovery problem

When a server changes, here's how we find out:

```
Server changes
      │
      ▼
App silently produces wrong/missing data
      │
      ▼
User notices something is wrong
      │
      ├──→ Good feedback (user sees specific error) → fast fix
      │
      └──→ Bad feedback (user sees nothing or generic error) → slow fix
```

The quality of user feedback determines fix speed. This is why **error messages matter** — not just for tests, but for the user experience.

## Error feedback design

Every failure mode should produce **actionable user feedback** with:

1. **What broke** — which cinema? which rating source?
2. **Why it broke** — network error? site changed? blocked by Cloudflare?
3. **What the user can do** — retry? wait? report?
4. **What to include in a bug report** — timestamp, error message, cinema name

See `ERROR_HANDLING.md` for the current error feedback implementation + planned improvements.
