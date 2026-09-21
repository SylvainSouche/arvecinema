import type { Movie } from '../../shared/types';
import { RATING_SOURCES } from './ratingSources';
import { getRatingsByTconst } from './imdbDatasetClient';
import {
  getRatingsCacheEntry,
  upsertRatingsCacheEntry,
  getIdsCacheEntryByQid,
  type RatingsCacheRow,
} from './cacheDb';
import { isCancelled } from './shutdown';
import type { IdsCacheEntry, RatingsCacheEntry, ResolvedMovie } from './ratingsTypes';
import type { RatingsFetcher } from './pipelineInterfaces';
import type { ResolvedIds } from './RatingSource';
import { log } from './moduleLoggers';

// ──────────────────────────────────────────────────────────────────────────
// Ratings Fetcher — implementation of the RatingsFetcher interface.
//
// All ratings cache (read/write) and source-specific scraping is
// encapsulated here. The orchestrator never touches cacheDb or any
// rating source client directly.
//
// Phase 2 uses RATING_SOURCES (pluggable) instead of hardcoded AC+RT.
// ──────────────────────────────────────────────────────────────────────────

const RATINGS_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_CONCURRENCY = 4;

const DEBUG = process.env.ARVE_DEBUG === '1';
const NO_CACHE = process.env.ARVE_NO_CACHE === '1';
function debug(...args: unknown[]) {
  if (DEBUG) log.ratingsFetcher.info(args.join(' '));
}

// ── In-flight dedup ────────────────────────────────────────────────────────

const inflightRatings = new Map<string, Promise<RatingsCacheEntry>>();

// ── Cache read/write (encapsulated) ───────────────────────────────────────

function rowToRatingsEntry(row: RatingsCacheRow | null): RatingsCacheEntry | null {
  if (!row) return null;
  return {
    allocinePress: row.allocine_press ?? undefined,
    allocineAudience: row.allocine_audience ?? undefined,
    allocineVotes: row.allocine_votes ?? undefined,
    allocineUrl: row.allocine_url ?? undefined,
    allocineStatus: (row.allocine_status as RatingsCacheEntry['allocineStatus']) ?? undefined,
    allocineStatusMessage: row.allocine_status_message ?? undefined,
    imdbRating: row.imdb_rating ?? undefined,
    imdbVotes: row.imdb_votes ?? undefined,
    imdbUrl: row.imdb_url ?? undefined,
    imdbStatus: (row.imdb_status as RatingsCacheEntry['imdbStatus']) ?? undefined,
    imdbStatusMessage: row.imdb_status_message ?? undefined,
    rtTomatometer: row.rt_tomatometer ?? undefined,
    rtCertifiedFresh: row.rt_certified_fresh ? true : false,
    rtUrl: row.rt_url ?? undefined,
    rtStatus: (row.rt_status as RatingsCacheEntry['rtStatus']) ?? undefined,
    rtStatusMessage: row.rt_status_message ?? undefined,
    fetchedAt: row.fetched_at,
  };
}

function readRatingsCacheEntry(qid: string): RatingsCacheEntry | null {
  if (NO_CACHE) return null;
  return rowToRatingsEntry(getRatingsCacheEntry(qid));
}

function writeRatingsCacheEntry(qid: string, entry: RatingsCacheEntry): void {
  if (NO_CACHE) return;
  upsertRatingsCacheEntry({
    qid,
    imdb_rating: entry.imdbRating ?? null,
    imdb_votes: entry.imdbVotes ?? null,
    imdb_url: entry.imdbUrl ?? null,
    imdb_status: entry.imdbStatus ?? null,
    imdb_status_message: entry.imdbStatusMessage ?? null,
    allocine_press: entry.allocinePress ?? null,
    allocine_audience: entry.allocineAudience ?? null,
    allocine_votes: entry.allocineVotes ?? null,
    allocine_url: entry.allocineUrl ?? null,
    allocine_status: entry.allocineStatus ?? null,
    allocine_status_message: entry.allocineStatusMessage ?? null,
    rt_tomatometer: entry.rtTomatometer ?? null,
    rt_certified_fresh: entry.rtCertifiedFresh ? 1 : 0,
    rt_url: entry.rtUrl ?? null,
    rt_status: entry.rtStatus ?? null,
    rt_status_message: entry.rtStatusMessage ?? null,
    fetched_at: entry.fetchedAt,
  });
}

function isFresh(entry: RatingsCacheEntry | null): boolean {
  if (NO_CACHE || !entry) return false;
  if (!entry.fetchedAt) return false;
  const age = Date.now() - new Date(entry.fetchedAt).getTime();
  if (age >= RATINGS_TTL_MS) return false;
  if (entry.allocineStatus === undefined) return false;
  if (entry.rtStatus === undefined) return false;
  return true;
}

// ── Apply ratings to movie ─────────────────────────────────────────────────

export function applyRatings(movie: Movie, ids: IdsCacheEntry, ratings: RatingsCacheEntry): void {
  Object.assign(movie, {
    imdbId: ids.imdbId,
    imdbRating: ratings.imdbRating,
    imdbVotes: ratings.imdbVotes,
    imdbUrl:
      ratings.imdbUrl ?? (ids.imdbId ? `https://www.imdb.com/title/${ids.imdbId}/` : undefined),
    imdbStatus: ratings.imdbStatus,
    imdbStatusMessage: ratings.imdbStatusMessage,
    allocinePress: ratings.allocinePress,
    allocineAudience: ratings.allocineAudience,
    allocineVotes: ratings.allocineVotes,
    allocineUrl: ratings.allocineUrl,
    allocineStatus: ratings.allocineStatus,
    allocineStatusMessage: ratings.allocineStatusMessage,
    rtTomatometer: ratings.rtTomatometer,
    rtCertifiedFresh: ratings.rtCertifiedFresh,
    rtUrl: ratings.rtUrl,
    rtStatus: ratings.rtStatus,
    rtStatusMessage: ratings.rtStatusMessage,
    wikidataUrl: `https://www.wikidata.org/wiki/${ids.qid}`,
  });
}

// ── Helpers ────────────────────────────────────────────────────────────────

function toResolvedIds(ids: IdsCacheEntry): ResolvedIds {
  return {
    qid: ids.qid,
    imdbId: ids.imdbId,
    tmdbId: ids.tmdbId,
    rtPath: ids.rtPath,
    allocineId: ids.allocineId,
  };
}

/** Map a RatingFetchResult to the appropriate fields on RatingsCacheEntry
 *  based on the source ID. */
function mergeResult(
  entry: RatingsCacheEntry,
  sourceId: string,
  result: import('./RatingSource').RatingFetchResult,
): void {
  switch (sourceId) {
    case 'imdb':
      entry.imdbRating = result.rating;
      entry.imdbVotes = result.votes;
      entry.imdbUrl = result.url;
      entry.imdbStatus = result.status;
      entry.imdbStatusMessage = result.statusMessage;
      break;
    case 'allocine':
      entry.allocinePress = result.rating;
      entry.allocineAudience = result.secondaryRating;
      entry.allocineVotes = result.secondaryVotes;
      entry.allocineUrl = result.url;
      entry.allocineStatus = result.status;
      entry.allocineStatusMessage = result.statusMessage;
      break;
    case 'rt':
      entry.rtTomatometer = result.rating;
      entry.rtCertifiedFresh = result.certifiedFresh;
      entry.rtUrl = result.url;
      entry.rtStatus = result.status;
      entry.rtStatusMessage = result.statusMessage;
      break;
  }
}

// ── RatingsFetcher implementation ─────────────────────────────────────────

export const ratingsFetcher: RatingsFetcher = {
  applyCachedRatings(
    movie: Movie,
    ids: IdsCacheEntry,
    onUpdated: (movie: Movie) => void,
  ): { found: boolean; fresh: boolean } {
    const cached = readRatingsCacheEntry(ids.qid);
    if (!cached) return { found: false, fresh: false };
    applyRatings(movie, ids, cached);
    onUpdated(movie);
    return { found: true, fresh: isFresh(cached) };
  },

  applyImdbFromDataset(movie: Movie, ids: IdsCacheEntry, onUpdated: (movie: Movie) => void): void {
    if (!ids.imdbId) return;
    if (movie.imdbRating !== undefined) return; // already set
    const imdbEntry = getRatingsByTconst([ids.imdbId]).get(ids.imdbId);
    if (!imdbEntry) return;
    const entry = readRatingsCacheEntry(ids.qid) ?? { fetchedAt: new Date().toISOString() };
    entry.imdbRating = imdbEntry.rating;
    entry.imdbVotes = imdbEntry.votes;
    entry.imdbUrl = `https://www.imdb.com/title/${ids.imdbId}/`;
    entry.imdbStatus = 'ok';
    entry.imdbStatusMessage = undefined;
    writeRatingsCacheEntry(ids.qid, entry);
    applyRatings(movie, ids, entry);
    onUpdated(movie);
    debug(`  imdb: dataset rating ${imdbEntry.rating} applied immediately`);
  },

  reapplyImdbAfterRefresh(movies: Movie[], onUpdated: (movie: Movie) => void): void {
    debug('dataset refreshed — re-applying IMDB ratings');
    let changedCount = 0;
    for (const movie of movies) {
      if (!movie.imdbId) continue;
      const entry = getRatingsByTconst([movie.imdbId]).get(movie.imdbId);
      if (!entry) continue;
      // Extract QID from movie.wikidataUrl
      if (!movie.wikidataUrl) continue;
      const qidMatch = movie.wikidataUrl.match(/\/(Q\d+)$/);
      if (!qidMatch) continue;
      const qid = qidMatch[1];
      const existing = readRatingsCacheEntry(qid) ?? { fetchedAt: new Date().toISOString() };
      if (existing.imdbRating !== entry.rating) {
        existing.imdbRating = entry.rating;
        existing.imdbVotes = entry.votes;
        existing.imdbUrl = `https://www.imdb.com/title/${movie.imdbId}/`;
        existing.imdbStatus = 'ok';
        existing.imdbStatusMessage = undefined;
        existing.fetchedAt = new Date().toISOString();
        writeRatingsCacheEntry(qid, existing);
        applyRatings(movie, { qid, imdbId: movie.imdbId } as IdsCacheEntry, existing);
        onUpdated(movie);
        changedCount++;
      }
    }
    if (changedCount > 0) debug(`applied ${changedCount} updated IMDB ratings after refresh`);
  },

  batchImdbLookup(ratingsQueue: ResolvedMovie[], onUpdated: (movie: Movie) => void): void {
    const imdbIdsToFetch: string[] = [];
    const movieByImdbId = new Map<string, ResolvedMovie>();

    for (const item of ratingsQueue) {
      const cached = readRatingsCacheEntry(item.ids.qid);
      if (cached && isFresh(cached)) continue;
      if (!item.ids.imdbId) continue;
      if (movieByImdbId.has(item.ids.imdbId)) continue;
      movieByImdbId.set(item.ids.imdbId, item);
      imdbIdsToFetch.push(item.ids.imdbId);
    }

    if (imdbIdsToFetch.length === 0) return;

    debug(`phase 1.5: looking up ${imdbIdsToFetch.length} IMDB IDs in dataset`);
    const datasetResults = getRatingsByTconst(imdbIdsToFetch);
    debug(`phase 1.5: dataset returned ${datasetResults.size}/${imdbIdsToFetch.length} results`);

    for (const [imdbId, entry] of datasetResults) {
      const item = movieByImdbId.get(imdbId);
      if (!item) continue;
      const cached = readRatingsCacheEntry(item.ids.qid) ?? { fetchedAt: new Date().toISOString() };
      cached.imdbRating = entry.rating;
      cached.imdbVotes = entry.votes;
      cached.imdbUrl = `https://www.imdb.com/title/${imdbId}/`;
      cached.imdbStatus = 'ok';
      cached.imdbStatusMessage = undefined;
      cached.fetchedAt = new Date().toISOString();
      writeRatingsCacheEntry(item.ids.qid, cached);
      applyRatings(item.movie, item.ids, cached);
      onUpdated(item.movie);
    }

    for (const imdbId of imdbIdsToFetch) {
      if (!datasetResults.has(imdbId)) {
        const item = movieByImdbId.get(imdbId);
        if (!item) continue;
        const cached = readRatingsCacheEntry(item.ids.qid) ?? {
          fetchedAt: new Date().toISOString(),
        };
        cached.imdbStatus = 'absent';
        cached.imdbStatusMessage = 'Not in IMDB dataset (released within last 24h?)';
        cached.imdbUrl = `https://www.imdb.com/title/${imdbId}/`;
        writeRatingsCacheEntry(item.ids.qid, cached);
      }
    }
  },

  async scrapeAll(
    queue: ResolvedMovie[],
    onUpdated: (movie: Movie) => void,
    onProgress: () => void,
  ): Promise<void> {
    const workers: Promise<void>[] = [];
    for (let i = 0; i < Math.min(MAX_CONCURRENCY, queue.length); i++) {
      workers.push(processRatingsQueue(queue, onUpdated, onProgress));
    }
    await Promise.all(workers);
  },
};

// ── Retry: re-fetch only sources that previously failed with status='blocked' ──
//
// The retry path differs from the normal Phase 2 in three ways:
//   1. It iterates over movies already in the renderer's state (passed in
//      by the caller), not over the original Phase 0/1 ratingsQueue.
//   2. For each movie, it ONLY fetches sources whose current status is
//      'blocked' — leaving 'ok' and 'absent' untouched.
//   3. It always re-scrapes, ignoring the freshness TTL — the user explicitly
//      asked for a retry, so we honor that even if the cache is "fresh"
//      (which can happen if the previous failed attempt wrote a 'blocked'
//      entry and the 24h TTL hasn't elapsed).

/**
 * Re-fetch ratings for sources that previously returned status='blocked'.
 *
 * @param movies    The movies currently displayed in the UI (mutated in place + onUpdated fired per update).
 * @param onUpdated Callback fired after each movie's ratings are updated.
 * @param onProgress Callback fired after each movie is fully processed (success or failure).
 * @returns A summary of the retry attempt.
 */
export async function retryFailedLookups(
  movies: Movie[],
  onUpdated: (movie: Movie) => void,
  onProgress: () => void,
): Promise<{ retried: number; succeeded: number; stillFailing: number }> {
  debug(`retry: scanning ${movies.length} movies for blocked sources`);

  // Build a queue of { movie, ids, sourcesToRetry } for movies that have
  // at least one blocked source AND a known QID (we need the QID to read
  // and write the ratings cache).
  const retryQueue: Array<{
    movie: Movie;
    ids: IdsCacheEntry;
    sourcesToRetry: string[];
  }> = [];

  for (const movie of movies) {
    // Need the QID to read/write cache. Extract from wikidataUrl.
    if (!movie.wikidataUrl) continue;
    const qidMatch = movie.wikidataUrl.match(/\/(Q\d+)$/);
    if (!qidMatch) continue;
    const qid = qidMatch[1];

    // Read the cached IDs entry to rebuild the IdsCacheEntry.
    // We need the IDs (imdbId, allocineId, rtPath) for the source to call
    // isAvailable() and fetchRating().
    const idsRow = getIdsCacheEntryByQid(qid);
    if (!idsRow) {
      debug(`retry: no ids_cache row for ${qid} ("${movie.title}") — skipping`);
      continue;
    }

    const ids: IdsCacheEntry = {
      qid: idsRow.qid,
      title: idsRow.title,
      imdbId: idsRow.imdb_id ?? undefined,
      tmdbId: idsRow.tmdb_id ?? undefined,
      rtPath: idsRow.rt_path ?? undefined,
      allocineId: idsRow.allocine_id ?? undefined,
    };

    // Determine which sources are currently blocked.
    const blocked: string[] = [];
    if (movie.imdbStatus === 'blocked') blocked.push('imdb');
    if (movie.allocineStatus === 'blocked') blocked.push('allocine');
    if (movie.rtStatus === 'blocked') blocked.push('rt');

    if (blocked.length === 0) continue;

    retryQueue.push({ movie, ids, sourcesToRetry: blocked });
  }

  if (retryQueue.length === 0) {
    debug('retry: no blocked sources to retry');
    return { retried: 0, succeeded: 0, stillFailing: 0 };
  }

  debug(`retry: ${retryQueue.length} movies with blocked sources, re-fetching...`);

  let succeeded = 0;
  let stillFailing = 0;

  // Process with the same MAX_CONCURRENCY as Phase 2.
  const queue = retryQueue.slice();
  const workers: Promise<void>[] = [];
  for (let i = 0; i < Math.min(MAX_CONCURRENCY, queue.length); i++) {
    workers.push(
      processRetryQueue(queue, onUpdated, onProgress, (ok) => {
        if (ok) succeeded++;
        else stillFailing++;
      }),
    );
  }
  await Promise.all(workers);

  debug(`retry complete: ${succeeded} sources recovered, ${stillFailing} still failing`);
  return { retried: retryQueue.length, succeeded, stillFailing };
}

/** Worker that processes the retry queue. For each item, only re-fetches the
 *  sources whose status is 'blocked'. Updates the cache + movie in place. */
async function processRetryQueue(
  queue: Array<{ movie: Movie; ids: IdsCacheEntry; sourcesToRetry: string[] }>,
  onUpdated: (movie: Movie) => void,
  onProgress: () => void,
  onSourceComplete: (ok: boolean) => void,
): Promise<void> {
  while (queue.length > 0) {
    if (isCancelled()) return;
    const item = queue.shift();
    if (!item) break;

    const { movie, ids, sourcesToRetry } = item;
    const resolvedIds = toResolvedIds(ids);

    // Read the current cache entry (so we can merge — preserving OK fields).
    const existing = readRatingsCacheEntry(ids.qid);
    const entry: RatingsCacheEntry = existing ?? { fetchedAt: new Date().toISOString() };

    let anyRecovered = false;

    for (const sourceId of sourcesToRetry) {
      if (isCancelled()) break;

      const source = RATING_SOURCES.find((s) => s.id === sourceId);
      if (!source) continue;

      // If the source still can't fetch (e.g. IDs missing), skip.
      if (!source.isAvailable(resolvedIds, movie)) {
        debug(`  retry ${sourceId}: not available (missing IDs) — skipping`);
        continue;
      }

      debug(`  retry ${sourceId}: re-fetching "${movie.title}"...`);
      try {
        const result = await source.fetchRating(resolvedIds, movie);
        if (result && result.status === 'ok') {
          mergeResult(entry, source.id, result);
          anyRecovered = true;
          onSourceComplete(true);
          debug(`  retry ${sourceId}: recovered → rating=${result.rating ?? '-'}`);
        } else if (result) {
          // Still blocked or absent — update the entry to reflect the latest attempt.
          mergeResult(entry, source.id, result);
          onSourceComplete(false);
          debug(`  retry ${sourceId}: still ${result.status}`);
        } else {
          // fetchRating returned null — unexpected exception. Leave the
          // existing 'blocked' status in place.
          onSourceComplete(false);
          debug(`  retry ${sourceId}: fetchRating returned null`);
        }
      } catch (err) {
        onSourceComplete(false);
        log.ratingsFetcher.warn(
          `retry ${sourceId} threw: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // Write the updated cache entry + apply to movie + notify UI.
    entry.fetchedAt = new Date().toISOString();
    writeRatingsCacheEntry(ids.qid, entry);
    applyRatings(movie, ids, entry);
    onUpdated(movie);
    onProgress();

    if (anyRecovered) {
      debug(`retry: "${movie.title}" recovered at least one source`);
    }
  }
}

// ── Phase 2 worker — iterates over RATING_SOURCES (pluggable) ─────────────

async function processRatingsQueue(
  queue: ResolvedMovie[],
  onUpdated: (movie: Movie) => void,
  onProgress: () => void,
): Promise<void> {
  while (queue.length > 0) {
    if (isCancelled()) return;
    const item = queue.shift();
    if (!item) break;

    const { movie, ids } = item;

    try {
      const ratingsKey = ids.qid;
      const cachedRatings = readRatingsCacheEntry(ratingsKey);

      if (cachedRatings && isFresh(cachedRatings)) {
        applyRatings(movie, ids, cachedRatings);
        onUpdated(movie);
        debug(`cache hit (fresh): "${movie.title}"`);
        onProgress();
        continue;
      }

      let inflightRating = inflightRatings.get(ratingsKey);
      if (!inflightRating) {
        debug(`fetching ratings for "${movie.title}" (QID=${ids.qid})`);
        inflightRating = (async (): Promise<RatingsCacheEntry> => {
          const existing = readRatingsCacheEntry(ratingsKey);
          const entry: RatingsCacheEntry = existing ?? { fetchedAt: new Date().toISOString() };
          try {
            const resolvedIds = toResolvedIds(ids);

            // Iterate over ALL registered sources (pluggable — not hardcoded)
            for (const source of RATING_SOURCES) {
              if (!source.isAvailable(resolvedIds, movie)) {
                // Mark as absent for sources that can't fetch this film
                switch (source.id) {
                  case 'imdb':
                    if (entry.imdbStatus === undefined) {
                      entry.imdbStatus = 'absent';
                      entry.imdbStatusMessage = "Pas d'ID IMDB";
                    }
                    break;
                  case 'allocine':
                    if (entry.allocineStatus === undefined) {
                      entry.allocineStatus = 'absent';
                      entry.allocineStatusMessage = "Pas d'ID AlloCiné";
                    }
                    break;
                  case 'rt':
                    if (entry.rtStatus === undefined) {
                      entry.rtStatus = 'absent';
                      entry.rtStatusMessage = 'Pas de path RT';
                    }
                    break;
                }
                continue;
              }

              // Skip IMDB if already resolved by Phase 1.5
              if (source.id === 'imdb' && entry.imdbStatus === 'ok') {
                debug(`  ${source.id}: already resolved (rating=${entry.imdbRating})`);
                continue;
              }

              debug(`  ${source.id}: fetching...`);
              const result = await source.fetchRating(resolvedIds, movie);
              if (result) {
                mergeResult(entry, source.id, result);
                debug(`  ${source.id}: status=${result.status}, rating=${result.rating ?? '-'}`);
                // Notify immediately — this source's score is ready
                applyRatings(movie, ids, entry);
                onUpdated(movie);
              }
            }

            entry.fetchedAt = new Date().toISOString();
            writeRatingsCacheEntry(ratingsKey, entry);
          } finally {
            inflightRatings.delete(ratingsKey);
          }
          return entry;
        })();
        inflightRatings.set(ratingsKey, inflightRating);
      }

      const entry = await inflightRating;
      applyRatings(movie, ids, entry);
      onUpdated(movie);
      debug(`  done: "${movie.title}"`);
      onProgress();
    } catch (err) {
      log.ratingsFetcher.warn(
        `[ratings-fetcher] failed for "${movie.title}":` +
          ' ' +
          (err instanceof Error ? err.message : String(err)),
      );
      onProgress();
    }
  }
}
