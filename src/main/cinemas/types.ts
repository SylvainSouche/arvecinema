// ──────────────────────────────────────────────────────────────────────────
// Adapter-facing types.
//
// Domain types (Showtime, Movie, CinemaInfo, ScheduleResponse) and the VF/VO
// helpers live in `src/shared/types.ts` so both the main process and the
// renderer can import them. This module only declares the adapter contract
// + the Cinema config object that wraps an adapter.
// ──────────────────────────────────────────────────────────────────────────

export type {
  Showtime,
  Movie,
  CinemaInfo,
  ScheduleResponse,
  CinemaStatus,
  AudioFilter,
} from '../../shared/types';
export {
  isVFShowtime as isVFTags,
  isVOShowtime as isVOTags,
  DEFAULT_RUNTIME_HOURS,
  TIMEZONE,
} from '../../shared/types';

import type { Movie } from '../../shared/types';

/**
 * Per-cinema fetch result. The IPC handler in `src/main/index.ts` wraps this
 * with a `CinemaStatus` to produce a `ScheduleResponse`.
 */
export interface CinemaFetchResult {
  availableDays: string[];
  movies: Movie[];
}

/** A cinema's static configuration + the adapter that fetches its schedule. */
export interface Cinema {
  /** Stable slug, e.g. "mont-blanc". */
  id: string;
  /** Display name, e.g. "Ciné Mont-Blanc". */
  name: string;
  /** City, e.g. "Sallanches". */
  city: string;
  /** Hex color used for the cinema badge on each showtime chip. */
  color: string;
  adapter: CinemaAdapter;
}

/** Contract every cinema source must implement. */
export interface CinemaAdapter {
  /**
   * Fetch the schedule for this cinema.
   * @param windowDays  how many days from today to include
   * @returns           list of movies with showtimes + the list of available days
   * @throws            on HTTP failure, timeout, or scraper schema change
   *                     (ScraperSchemaChangedError) — the caller wraps the
   *                     failure into a CinemaStatus.
   */
  fetchSchedule(windowDays: number): Promise<CinemaFetchResult>;
}
