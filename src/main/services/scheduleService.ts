import type { Movie, ScheduleResponse, CinemaStatus } from '../cinemas/types';
import type { EnrichOptions } from '../ratings/ratingsEnricher';

// ──────────────────────────────────────────────────────────────────────────
// scheduleService — orchestration of a schedule refresh (ARCH-01).
//
// Extracted from main/index.ts so the parallel fetch, per-cinema error
// classification, global title sort, availableDays union and the ratings
// hand-off are unit-testable WITHOUT electron: every side-effectful piece
// (adapter fetch, enrichment, IPC broadcast) is an injected dependency.
//
// Behavior-preserving with the previous inline implementation, including:
//   - parallel fetch via Promise.all
//   - error classification: TimeoutError → 'timeout',
//     ScraperSchemaChangedError → 'parse-error', anything else →
//     'http-error' (message always preserved for the status banner)
//   - movies sorted by title (fr collation, cinemaId tiebreaker)
//   - enrichment handed the movies array (mutated in place by Phase 0
//     before the response is returned)
//   - per-movie publish callback relayed to injectable publisher
//   - refresh-generation staleness: a superseded run's publishes are
//     suppressed HERE as well (belt and suspenders — the real enricher
//     also gates on the same isStale closure).
// ──────────────────────────────────────────────────────────────────────────

/** Classify a cinema fetch failure the way the status banner expects. */
export function classifyCinemaError(err: unknown): { reason: CinemaStatus['status']; message: string } {
  const reason =
    err instanceof Error && err.name === 'TimeoutError'
      ? 'timeout'
      : err instanceof Error && err.name === 'ScraperSchemaChangedError'
        ? 'parse-error'
        : 'http-error';
  const message = err instanceof Error ? err.message : String(err);
  return { reason, message };
}

export interface CinemaFetchResult {
  availableDays: string[];
  movies: Movie[];
}

export interface EnabledCinema {
  /** Stable cinema slug (status payloads, logging). */
  id: string;
  /** Its schedule-fetch thunk (adapter seam — electron stays out). */
  fetch: (days: number) => Promise<CinemaFetchResult>;
}

export interface ScheduleServiceDeps {
  /** Fetch one cinema's schedule (adapter seam). */
  fetchScheduleOf: (cinema: EnabledCinema, days: number) => Promise<CinemaFetchResult>;
  /** Enrichment (ratings pipeline seam). */
  enrich: (movies: Movie[], onUpdated: (m: Movie) => void, opts?: EnrichOptions) => Promise<void>;
  /** Per-movie ratings broadcast (IPC seam). */
  publishRatingUpdate: (movie: Movie) => void;
  /** Failure log seam (kept out of electron for tests). */
  logError: (cinemaId: string, reason: string, message: string) => void;
}

export interface FetchSchedulesOptions {
  enabled: EnabledCinema[];
  days: number;
  isStale: () => boolean;
  /** Await enrichment completion before resolving (dev export does). */
  awaitEnrichment?: boolean;
}

/**
 * Orchestrate one schedule refresh across the enabled cinemas.
 * Returns the aggregated ScheduleResponse; enrichment continues in the
 * background unless `awaitEnrichment` is set.
 */
export async function fetchSchedules(
  deps: ScheduleServiceDeps,
  opts: FetchSchedulesOptions,
): Promise<ScheduleResponse> {
  const { enabled, days, isStale } = opts;

  const results = await Promise.all(
    enabled.map(async (c): Promise<{ status: CinemaStatus; availableDays: string[]; movies: Movie[] }> => {
      try {
        const r = await deps.fetchScheduleOf(c, days);
        return { status: { cinemaId: c.id, status: 'ok' }, availableDays: r.availableDays, movies: r.movies };
      } catch (err) {
        const { reason, message } = classifyCinemaError(err);
        deps.logError(c.id, reason, message);
        return { status: { cinemaId: c.id, status: reason, error: message }, availableDays: [], movies: [] };
      }
    }),
  );

  // Union of available days (sorted, deduplicated).
  const daySet = new Set<string>();
  for (const r of results) for (const d of r.availableDays) daySet.add(d);
  const availableDays = [...daySet].sort();

  // One Movie entry per (cinema, film): global title sort, cinemaId
  // tiebreaker so the same film at two cinemas appears adjacent (UX-03).
  const movies = results
    .flatMap((r) => r.movies)
    .sort((a, b) => {
      const t = a.title.localeCompare(b.title, 'fr', { sensitivity: 'base' });
      return t !== 0 ? t : a.cinemaId.localeCompare(b.cinemaId);
    });

  const cinemaStatuses: CinemaStatus[] = results.map((r) => r.status);

  // Enrichment: per-movie publishes are relayed, unless this refresh
  // generation has been superseded meanwhile.
  const enrichment = deps.enrich(movies, (movie) => {
    if (isStale()) return;
    deps.publishRatingUpdate(movie);
  }, { isStale });
  if (opts.awaitEnrichment) await enrichment;

  return { availableDays, movies, cinemaStatuses };
}
