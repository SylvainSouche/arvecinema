import type { Movie } from '../../shared/types';
import type { IdsCacheEntry, ResolvedMovie } from './ratingsTypes';

// ──────────────────────────────────────────────────────────────────────────
// Pipeline interfaces — contracts between the orchestrator and its modules.
//
// The orchestrator (ratingsEnricher.ts) depends ONLY on these interfaces,
// never on the concrete implementations. This makes the pipeline testable
// (mock implementations) and pluggable (swap idResolver or ratingsFetcher
// without touching the orchestrator).
// ──────────────────────────────────────────────────────────────────────────

/**
 * ID Resolver — resolves Wikidata IDs (QID, IMDB, RT, AlloCiné) for movies.
 *
 * Responsibilities:
 *   - Phase 0: look up cached IDs from previous runs (SQLite)
 *   - Phase 1a: batch SPARQL for all films with AlloCiné IDs
 *   - Phase 1b: per-film title search for films without AlloCiné IDs
 *   - Cache all resolved IDs (permanent, no TTL)
 *   - Fire onUpdated() as each film gets its IDs (UI shows source icons)
 *   - Fire onImdbRating() as each film's IMDB rating is found in the dataset
 */
export interface IdResolver {
  /** Phase 0: look up cached IDs + cached ratings for all movies.
   *  Returns the list of movies that had cached IDs (with their IDs). */
  applyCachedIds(
    movies: Movie[],
    onUpdated: (movie: Movie) => void,
    onImdbRating: (movie: Movie, ids: IdsCacheEntry) => void,
    onProgress: () => void,
  ): ResolvedMovie[];

  /** Phase 1: resolve IDs for all movies NOT resolved in Phase 0.
   *  Returns the full ratings queue (Phase 0 hits + Phase 1 resolutions). */
  resolveIds(
    unresolvedMovies: Movie[],
    ratingsQueue: ResolvedMovie[],
    onUpdated: (movie: Movie) => void,
    onProgress: () => void,
    onImdbRating: (movie: Movie, ids: IdsCacheEntry) => void,
  ): Promise<void>;

  /** Extract the QID from a movie's wikidataUrl (for dataset refresh callback). */
  findQidForMovie(movie: Movie): string | null;
}

/**
 * Ratings Fetcher — fetches and caches ratings from all sources.
 *
 * Responsibilities:
 *   - Phase 0: apply cached ratings from SQLite (even if stale)
 *   - Phase 1.5: batch IMDB dataset lookup
 *   - Phase 2: scrape AlloCiné + RT per-film (iterates over RATING_SOURCES)
 *   - Cache all fetched ratings (24h TTL)
 *   - Fire onUpdated() as each source completes (progressive display)
 */
export interface RatingsFetcher {
  /** Phase 0: read cached ratings for a movie (by QID). Returns null if
   *  no cached entry exists. Also returns isFresh flag so the orchestrator
   *  can skip Phase 2 for fresh entries. */
  applyCachedRatings(
    movie: Movie,
    ids: IdsCacheEntry,
    onUpdated: (movie: Movie) => void,
  ): { found: boolean; fresh: boolean };

  /** Phase 0: check IMDB dataset directly (imdb_ratings table) for a
   *  film whose ratings_cache.imdb_rating is NULL. */
  applyImdbFromDataset(
    movie: Movie,
    ids: IdsCacheEntry,
    onUpdated: (movie: Movie) => void,
  ): void;

  /** Dataset refresh callback: re-apply IMDB ratings after the dataset
   *  is refreshed in the background. */
  reapplyImdbAfterRefresh(
    movies: Movie[],
    onUpdated: (movie: Movie) => void,
  ): void;

  /** Phase 1.5: batch-lookup all unresolved IMDB IDs in the dataset. */
  batchImdbLookup(
    ratingsQueue: ResolvedMovie[],
    onUpdated: (movie: Movie) => void,
  ): void;

  /** Phase 2: scrape all sources (AlloCiné + RT) for all films in the
   *  queue, sorted by next screening time. Workers run in parallel. */
  scrapeAll(
    queue: ResolvedMovie[],
    onUpdated: (movie: Movie) => void,
    onProgress: () => void,
  ): Promise<void>;
}
