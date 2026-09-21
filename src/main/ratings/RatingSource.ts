import type { Movie } from '../../shared/types';

// ──────────────────────────────────────────────────────────────────────────
// RatingSource — common interface for all rating providers.
//
// Each source (IMDB dataset, AlloCiné scraper, Rotten Tomatoes scraper)
// implements this interface. The enrichment orchestrator iterates over
// registered sources and calls fetchRating() for each one, without
// knowing the implementation details.
//
// This makes the pipeline pluggable: adding a new source (e.g. Metacritic,
// SensCritique, Letterboxd) only requires implementing this interface and
// registering it in the orchestrator — no changes to existing code.
// ──────────────────────────────────────────────────────────────────────────

/** IDs resolved from Wikidata, needed to look up ratings. */
export interface ResolvedIds {
  qid: string;
  imdbId?: string;
  tmdbId?: string;
  rtPath?: string;
  allocineId?: string;
}

/** Result of a single source's rating fetch. */
export interface RatingFetchResult {
  /** The source's rating value (e.g. 7.8 for IMDB, 3.5 for AlloCiné). */
  rating?: number;
  /** Vote count (if available). */
  votes?: number;
  /** Full URL to the source's page for this film. */
  url?: string;
  /** Secondary rating (e.g. AlloCiné has both press + audience). */
  secondaryRating?: number;
  /** Secondary rating votes (e.g. AlloCiné audience votes). */
  secondaryVotes?: number;
  /** Whether the film was certified fresh (RT only). */
  certifiedFresh?: boolean;
  /** Fetch status. */
  status: 'ok' | 'absent' | 'blocked';
  /** Human-readable status message for error cases. */
  statusMessage?: string;
}

/** Common interface for all rating sources. */
export interface RatingSource {
  /** Unique identifier for this source (e.g. 'imdb', 'allocine', 'rt'). */
  readonly id: string;

  /** Human-readable name for UI display. */
  readonly displayName: string;

  /** Check if this source can fetch a rating for the given IDs.
   *  Returns false if the required identifier is missing (e.g. RT needs
   *  an rtPath, AlloCiné needs an allocineId or title to search). */
  isAvailable(ids: ResolvedIds, movie: Movie): boolean;

  /** Fetch the rating for the given film.
   *  Returns the rating result, or null if the fetch failed entirely
   *  (network error, unexpected exception). */
  fetchRating(ids: ResolvedIds, movie: Movie): Promise<RatingFetchResult | null>;
}
