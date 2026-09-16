// ──────────────────────────────────────────────────────────────────────────
// RatingProvider — unified interface for all rating scrapers.
//
// To add a new rating source:
//   1. Implement the RatingProvider interface below
//   2. Register it in RATING_PROVIDERS in ratingsEnricher.ts
//   3. Add the result fields to the CacheEntry + Movie interface
//
// Each provider:
//   - Receives the movie's external IDs (from Wikidata lookup)
//   - Returns whatever ratings it can fetch (or null on failure)
//   - Is independent — one provider failing doesn't block others
// ──────────────────────────────────────────────────────────────────────────

/** External IDs passed to each provider (from Wikidata lookup). */
export interface MovieIds {
  qid: string;
  title: string;
  imdbId?: string;
  tmdbId?: string;
  rtPath?: string;
  allocineId?: string;
}

/** Result of a rating provider — partial ratings to merge into the movie. */
export interface ProviderResult {
  /** Provider ID — used for logging + cache key suffix. */
  providerId: string;
  /** Arbitrary key-value pairs to merge into the Movie object. */
  ratings: Record<string, unknown>;
}

/** Unified interface every rating scraper implements. */
export interface RatingProvider {
  /** Unique provider ID (e.g. 'allocine', 'imdb', 'rt'). */
  readonly id: string;

  /** Fetch ratings for a movie given its external IDs.
   *  Returns null if the provider has no data or fails. */
  fetch(ids: MovieIds): Promise<ProviderResult | null>;
}
