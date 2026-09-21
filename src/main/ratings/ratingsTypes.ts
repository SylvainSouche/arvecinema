import type { Movie } from '../../shared/types';

// ──────────────────────────────────────────────────────────────────────────
// Shared types for the ratings pipeline.
//
// These types are used by the orchestrator, idResolver, ratingsFetcher,
// and RatingSource implementations. Keeping them in one place avoids
// circular dependencies between modules.
// ──────────────────────────────────────────────────────────────────────────

/** IDs resolved from Wikidata, needed to look up ratings. */
export interface IdsCacheEntry {
  qid: string;
  title: string;
  imdbId?: string;
  tmdbId?: string;
  rtPath?: string;
  allocineId?: string;
}

/** All rating sources' data, stored in the ratings_cache table. */
export interface RatingsCacheEntry {
  // AlloCiné
  allocinePress?: number;
  allocineAudience?: number;
  allocineVotes?: number;
  allocineUrl?: string;
  allocineStatus?: 'ok' | 'absent' | 'blocked';
  allocineStatusMessage?: string;
  // IMDB
  imdbRating?: number;
  imdbVotes?: number;
  imdbUrl?: string;
  imdbStatus?: 'ok' | 'absent' | 'blocked';
  imdbStatusMessage?: string;
  // RT
  rtTomatometer?: number;
  rtCertifiedFresh?: boolean;
  rtUrl?: string;
  rtStatus?: 'ok' | 'absent' | 'blocked';
  rtStatusMessage?: string;
  // Metadata
  fetchedAt: string;
}

/** A movie + its resolved IDs, ready for ratings fetching. */
export interface ResolvedMovie {
  movie: Movie;
  ids: IdsCacheEntry;
}
