import type { Movie } from '../../shared/types';
import { BrowserWindow } from 'electron';
import { initDataset, onDatasetRefreshed } from './imdbDatasetClient';
import { idResolver } from './idResolver';
import { ratingsFetcher } from './ratingsFetcher';
import type { IdResolver, RatingsFetcher } from './pipelineInterfaces';
import type { ResolvedMovie } from './ratingsTypes';

// ──────────────────────────────────────────────────────────────────────────
// Ratings Enricher — orchestrator.
//
// This module coordinates the enrichment pipeline. It depends on the
// IdResolver and RatingsFetcher interfaces for ID resolution + ratings
// scraping. It does NOT touch cacheDb, wikidataClient, allocineClient, or
// rottenTomatoesClient directly.
//
// EXCEPTION: it imports `initDataset` and `onDatasetRefreshed` from
// imdbDatasetClient. These are lifecycle hooks (initialize the dataset
// at startup, register a callback for background refreshes) that don't
// fit neatly into the RatingsFetcher interface. This is a pragmatic
// trade-off — the alternative would be adding a DatasetLifecycle
// interface for just 2 methods, which adds complexity without value.
//
// Pipeline:
//   Phase 0:  apply cached IDs + cached ratings (instant, SQLite)
//   Phase 1a: batch SPARQL for films with AlloCiné IDs (1 query)
//   Phase 1b: per-film title search for films without AlloCiné IDs
//   Phase 1.5: batch IMDB dataset lookup (instant, SQLite)
//   Phase 2:  scrape all sources (pluggable via RATING_SOURCES)
// ──────────────────────────────────────────────────────────────────────────

import { log } from './moduleLoggers';

const DEBUG = process.env.ARVE_DEBUG === '1';
function debug(...args: unknown[]) {
  if (DEBUG) log.enricher.info(args.join(' '));
}

// ── Progress tracking ──────────────────────────────────────────────────────

let progressTotal = 0;
let progressResolved = 0;

function resetProgress(total: number): void {
  progressTotal = total;
  progressResolved = 0;
  broadcastProgress();
}

function incrementProgress(): void {
  progressResolved++;
  broadcastProgress();
}

function broadcastProgress(): void {
  // Refresh-generation guard (review race fix): a superseded enrichment run
  // must not clobber the progress meter of the current run — especially
  // resetProgress(0/stale-total) which would visibly rewind the bar.
  if (progressStaleCheck?.()) return;
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('ratings:progress', {
      resolved: progressResolved,
      total: progressTotal,
      pct: progressTotal > 0 ? Math.round((progressResolved / progressTotal) * 100) : 0,
    });
  }
}

/** Staleness checker of the LATEST enrichWithRatings call that provided one.
 *  Per-run precision for rating:updated is handled at the call sites (they
  *  capture their own generation); the progress meter is a single shared
  *  module state, so the freshest checker is the meaningful one here. */
let progressStaleCheck: (() => boolean) | null = null;

// ── Enrichment pipeline ────────────────────────────────────────────────────

export interface EnrichOptions {
  /** Return true when THIS run has been superseded (a newer refresh started).
   *  Stale runs stop broadcasting progress immediately (entry included) and
   *  stop invoking onUpdated — the stale-checker closure decides it. */
  isStale?: () => boolean;
}

export function enrichWithRatings(
  movies: Movie[],
  onUpdated: (movie: Movie) => void,
  opts?: EnrichOptions,
): Promise<void> {
  const resolver: IdResolver = idResolver;
  const fetcher: RatingsFetcher = ratingsFetcher;
  const isStale = () => opts?.isStale?.() ?? false;
  // A stale run entering the pipeline must not reset the meter of the
  // current one (register the checker BEFORE resetProgress below).
  progressStaleCheck = isStale;

  // Per-movie rating updates always flow through this wrapper — a superseded
  // run contributes nothing to the renderer state (the run's own generation
  // is owned by the call site, which owns this closure).
  const guardedOnUpdated: (movie: Movie) => void = (movie) => {
    if (isStale()) return;
    onUpdated(movie);
  };

  debug(`starting enrichment of ${movies.length} movies`);
  resetProgress(movies.length);
  initDataset();

  // ── Phase 0: apply cached IDs + ratings ──────────────────────────────
  const phase0Start = Date.now();
  debug('phase 0: applying cached values');

  const phase0Resolved = resolver.applyCachedIds(
    movies,
    guardedOnUpdated,
    (movie, ids) => fetcher.applyImdbFromDataset(movie, ids, guardedOnUpdated),
    () => incrementProgress(),
  );

  // Also apply cached ratings for Phase 0 hits
  let freshCount = 0;
  for (const r of phase0Resolved) {
    const result = fetcher.applyCachedRatings(r.movie, r.ids, guardedOnUpdated);
    if (result.fresh) {
      incrementProgress();
      freshCount++;
    }
  }

  debug(
    `phase 0 done in ${Date.now() - phase0Start}ms: ${phase0Resolved.length}/${movies.length} IDs cached, ${freshCount} fresh → skip Phase 2`,
  );

  // ── Dataset refresh callback ──────────────────────────────────────────
  onDatasetRefreshed(() => {
    fetcher.reapplyImdbAfterRefresh(movies, guardedOnUpdated);
  });

  // ── Phase 1: resolve IDs for unresolved movies ───────────────────────
  const unresolvedMovies = movies.filter((m) => !phase0Resolved.some((r) => r.movie === m));
  debug(`phase 1: resolving ${unresolvedMovies.length} unresolved movies`);

  const ratingsQueue: ResolvedMovie[] = phase0Resolved.slice();
  const phase1Start = Date.now();

  return (async () => {
    await resolver.resolveIds(
      unresolvedMovies,
      ratingsQueue,
      guardedOnUpdated,
      () => incrementProgress(),
      (movie, ids) => fetcher.applyImdbFromDataset(movie, ids, guardedOnUpdated),
    );
    debug(`phase 1 done in ${Date.now() - phase1Start}ms: ${ratingsQueue.length} movies have IDs`);

    // ── Phase 1.5: batch IMDB dataset lookup ────────────────────────────
    fetcher.batchImdbLookup(ratingsQueue, guardedOnUpdated);

    // ── Phase 2: scrape all sources, sorted by next screening ───────────
    const phase2Queue = ratingsQueue.slice().sort((a, b) => {
      const aTime = nextScreeningTime(a.movie);
      const bTime = nextScreeningTime(b.movie);
      if (aTime === null && bTime === null) return 0;
      if (aTime === null) return 1;
      if (bTime === null) return -1;
      return aTime - bTime;
    });
    debug(`phase 2: scrape ${phase2Queue.length} films (sorted by next screening)`);
    const phase2Start = Date.now();
    await fetcher.scrapeAll(phase2Queue, guardedOnUpdated, () => incrementProgress());
    debug(`phase 2 done in ${Date.now() - phase2Start}ms: enrichment complete`);
  })();
}

/** Find the earliest future showtime for a movie. */
function nextScreeningTime(movie: Movie): number | null {
  if (!movie.showtimes || movie.showtimes.length === 0) return null;
  const now = Date.now();
  let earliest: number | null = null;
  for (const s of movie.showtimes) {
    const t = new Date(s.time).getTime();
    if (Number.isNaN(t)) continue;
    if (t < now) continue;
    if (earliest === null || t < earliest) earliest = t;
  }
  if (earliest === null) {
    for (const s of movie.showtimes) {
      const t = new Date(s.time).getTime();
      if (Number.isNaN(t)) continue;
      if (earliest === null || t > earliest) earliest = t;
    }
  }
  return earliest;
}
