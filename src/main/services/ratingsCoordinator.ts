import type { Movie } from '../cinemas/types';
import { movieToRatingUpdate, type RatingUpdateMessage } from './ratingUpdates';

// ──────────────────────────────────────────────────────────────────────────
// ratingsCoordinator — retry orchestration (ARCH-01 extraction).
//
// The ratings:retry IPC handler keeps the BOUNDARY work (sender check,
// parse+sanitize via security/ipcValidation) and delegates the ORCHESTRATION
// here: run retryFailedLookups, publish every updated movie through the
// provided broadcast seam, return the summary.
//
// Electron-free with injected seams — unit-testable in vitest.
// ──────────────────────────────────────────────────────────────────────────

export interface RetrySummary {
  retried: number;
  succeeded: number;
  stillFailing: number;
}

export type RetryFn = (
  movies: Movie[],
  onUpdated: (movie: Movie) => void,
  onProgress: () => void,
) => Promise<RetrySummary>;

export interface PublishFn {
  (message: RatingUpdateMessage): void;
}

/**
 * Run the blocked-source retry against already-validated movies, publishing
 * each rating update through `publish`. The heavy lifting (ids_cache reads,
 * fetch scheduling) stays in ratings/retryFailedLookups — server-side
 * identifiers are read from THERE, never trusted from the renderer payload.
 */
export async function retryBlockedLookups(
  movies: Movie[],
  deps: { publish: PublishFn; retry: RetryFn },
): Promise<RetrySummary> {
  return deps.retry(
    movies,
    (movie) => deps.publish(movieToRatingUpdate(movie)),
    // Progress callback — currently no-op. The renderer's ProgressBar is
    // wired to the `ratings:progress` channel; if we want retries to show
    // progress there, broadcast here. For now the count of blocked badges
    // on screen decreasing as each retry succeeds is the progress signal.
    () => {
      /* progress no-op */
    },
  );
}
