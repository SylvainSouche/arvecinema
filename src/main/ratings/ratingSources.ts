import type { RatingSource } from './RatingSource';
import { imdbDatasetSource } from './imdbDatasetClient';
import { allocineSource } from './allocineClient';
import { rottenTomatoesSource } from './rottenTomatoesClient';

// ──────────────────────────────────────────────────────────────────────────
// Rating sources registry — single source of truth for all available
// rating providers.
//
// The enrichment orchestrator iterates over this list. Adding a new source
// (e.g. Metacritic, SensCritique) only requires:
//   1. Implement the RatingSource interface in a new file
//   2. Import and add it to this array
//   3. No changes to the orchestrator or any other source
//
// Order matters: sources listed first get their ratings applied first
// (useful for Phase 0 cache reads + progressive display).
// ──────────────────────────────────────────────────────────────────────────

export const RATING_SOURCES: RatingSource[] = [
  imdbDatasetSource,
  allocineSource,
  rottenTomatoesSource,
];
