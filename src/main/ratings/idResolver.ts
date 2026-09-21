import type { Movie } from '../../shared/types';
import { findMovieIds, findByAllocineIdsBatch } from './wikidataClient';
import {
  getIdsCacheEntry,
  getIdsCacheEntryByTitleKey,
  getIdsCacheEntriesByTitlePrefix,
  upsertIdsCacheEntry,
  type IdsCacheRow,
} from './cacheDb';
import { isCancelled } from './shutdown';
import type { IdsCacheEntry, ResolvedMovie } from './ratingsTypes';
import type { IdResolver } from './pipelineInterfaces';
import { log } from './moduleLoggers';

// ──────────────────────────────────────────────────────────────────────────
// ID Resolver — implementation of the IdResolver interface.
//
// Handles Wikidata ID resolution (batch SPARQL + per-film title search)
// and the IDs cache (permanent, SQLite-backed). All cacheDb access for
// IDs is encapsulated here — the orchestrator never touches cacheDb.
// ──────────────────────────────────────────────────────────────────────────

const DEBUG = process.env.ARVE_DEBUG === '1';
const NO_CACHE = process.env.ARVE_NO_CACHE === '1';
function debug(...args: unknown[]) {
  if (DEBUG) log.idResolver.info(args.join(' '));
}

export const MAX_CONCURRENCY = 4;

// ── In-flight deduplication ────────────────────────────────────────────────

const inflightIds = new Map<string, Promise<IdsCacheEntry | null>>();

// ── Helpers (exported for use by other modules that need them) ─────────────

export function releaseYear(movie: Movie): number | undefined {
  if (!movie.release) return undefined;
  const y = new Date(movie.release).getUTCFullYear();
  return Number.isFinite(y) ? y : undefined;
}

const CINEMAS_WITH_REAL_ALLOCINE_IDS = new Set(['mont-blanc', 'cluses', 'bonneville']);

export function allocineIdFromMovie(movie: Movie): string | undefined {
  if (!CINEMAS_WITH_REAL_ALLOCINE_IDS.has(movie.cinemaId)) return undefined;
  if (movie.id && /^\d+$/.test(movie.id)) return movie.id;
  return undefined;
}

export function normalizeTitle(s: string): string {
  return s
    .toLowerCase()
    .replace(/[\u2018\u2019\u201b]/g, "'")
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s*[-:]\s*partie\s+\d+\s*[:\-]?\s*/g, ' ')
    .replace(/\s*[-:]\s*part\s+\d+\s*[:\-]?\s*/g, ' ')
    .replace(/\s+final\s*cut\s*$/i, '')
    .replace(/\s+extended\s*$/i, '')
    .replace(/\s+version\s+longue\s*$/i, '')
    .replace(/\s+version\s+courte\s*$/i, '')
    .replace(/\s*[:\-]\s*/g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function isCoherentMovie(
  movie: { title: string; year?: number },
  found: { title: string },
): boolean {
  return isCoherent(movie.title, found.title);
}

function isCoherent(expected: string, got: string): boolean {
  const a = normalizeTitle(expected);
  const b = normalizeTitle(got);
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.startsWith(b) || b.startsWith(a)) return true;
  const aTokens = a.split(' ').filter((t) => t.length > 2);
  const bTokens = b.split(' ').filter((t) => t.length > 2);
  const [shorter, longer] =
    aTokens.length <= bTokens.length ? [aTokens, bTokens] : [bTokens, aTokens];
  if (shorter.length >= 3) {
    const longerSet = new Set(longer);
    if (shorter.every((t) => longerSet.has(t))) return true;
  }
  return levenshtein(a, b) <= Math.max(3, Math.floor(Math.max(a.length, b.length) * 0.25));
}

function levenshtein(a: string, b: string): number {
  const m = a.length,
    n = b.length;
  if (!m) return n;
  if (!n) return m;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
  return dp[m][n];
}

// ── IDs cache (encapsulated — no external cacheDb access) ───────────────────

function rowToIdsEntry(row: IdsCacheRow | null): IdsCacheEntry | null {
  if (!row) return null;
  return {
    qid: row.qid,
    title: row.title,
    imdbId: row.imdb_id ?? undefined,
    tmdbId: row.tmdb_id ?? undefined,
    rtPath: row.rt_path ?? undefined,
    allocineId: row.allocine_id ?? undefined,
  };
}

function readIdsCacheEntry(cacheKey: string): IdsCacheEntry | null {
  if (NO_CACHE) return null;
  return rowToIdsEntry(getIdsCacheEntry(cacheKey));
}

function readIdsCacheEntryByTitle(titleKey: string): IdsCacheEntry | null {
  if (NO_CACHE) return null;
  return rowToIdsEntry(getIdsCacheEntryByTitleKey(titleKey));
}

function readIdsCacheEntryByTitleCrossCinema(normalizedTitle: string): IdsCacheEntry | null {
  if (NO_CACHE) return null;
  const rows = getIdsCacheEntriesByTitlePrefix(normalizedTitle);
  if (rows.length === 0) return null;
  if (rows.length === 1) {
    debug(`cross-cinema cache hit: "${normalizedTitle}" → QID=${rows[0].qid}`);
    return rowToIdsEntry(rows[0]);
  }
  return null;
}

function writeIdsCacheEntry(cacheKey: string, entry: IdsCacheEntry): void {
  if (NO_CACHE) return;
  upsertIdsCacheEntry({
    cache_key: cacheKey,
    qid: entry.qid,
    title: entry.title,
    imdb_id: entry.imdbId ?? null,
    tmdb_id: entry.tmdbId ?? null,
    rt_path: entry.rtPath ?? null,
    allocine_id: entry.allocineId ?? null,
  });
}

function lookupCachedIds(movie: Movie): IdsCacheEntry | null {
  const allocineId = allocineIdFromMovie(movie);
  const titleKey = `${normalizeTitle(movie.title)}:${releaseYear(movie) ?? ''}`;
  const idsCacheKey = allocineId ? `allocine:${allocineId}` : `title:${titleKey}`;
  return (
    readIdsCacheEntry(idsCacheKey) ??
    readIdsCacheEntryByTitle(titleKey) ??
    readIdsCacheEntryByTitleCrossCinema(normalizeTitle(movie.title))
  );
}

/** Apply IDs to a movie object (mutates in-place). */
export function applyIds(movie: Movie, ids: IdsCacheEntry): void {
  Object.assign(movie, {
    imdbId: ids.imdbId,
    imdbUrl: ids.imdbId ? `https://www.imdb.com/title/${ids.imdbId}/` : undefined,
    allocineId: ids.allocineId,
    allocineUrl: ids.allocineId
      ? `https://www.allocine.fr/film/fichefilm_gen_cfilm=${ids.allocineId}.html`
      : undefined,
    rtUrl: ids.rtPath ? `https://www.rottentomatoes.com/${ids.rtPath}` : undefined,
    wikidataUrl: `https://www.wikidata.org/wiki/${ids.qid}`,
    imdbStatus: undefined,
    allocineStatus: undefined,
    rtStatus: undefined,
  });
}

// ── IdResolver implementation ──────────────────────────────────────────────

export const idResolver: IdResolver = {
  findQidForMovie(movie: Movie): string | null {
    if (!movie.wikidataUrl) return null;
    const m = movie.wikidataUrl.match(/\/(Q\d+)$/);
    return m ? m[1] : null;
  },

  applyCachedIds(
    movies: Movie[],
    onUpdated: (movie: Movie) => void,
    onImdbRating: (movie: Movie, ids: IdsCacheEntry) => void,
    _onProgress: () => void,
  ): ResolvedMovie[] {
    const resolved: ResolvedMovie[] = [];

    for (const movie of movies) {
      const ids = lookupCachedIds(movie);
      if (!ids) continue;

      applyIds(movie, ids);
      onUpdated(movie);
      resolved.push({ movie, ids });

      // Check if ratings cache has a fresh entry (delegate to ratingsFetcher
      // via the onImdbRating callback + isFresh check done by orchestrator).
      // We just call onImdbRating here so the orchestrator can apply the
      // IMDB dataset rating if available.
      onImdbRating(movie, ids);
    }

    debug(`phase 0: ${resolved.length}/${movies.length} IDs from cache`);
    return resolved;
  },

  async resolveIds(
    unresolvedMovies: Movie[],
    ratingsQueue: ResolvedMovie[],
    onUpdated: (movie: Movie) => void,
    onProgress: () => void,
    onImdbRating: (movie: Movie, ids: IdsCacheEntry) => void,
  ): Promise<void> {
    // Phase 1a: batch SPARQL
    const batchEntries: Array<{ allocineId: string; expectedYear?: number; movie: Movie }> = [];
    const remaining: Movie[] = [];

    for (const movie of unresolvedMovies) {
      const allocineId = allocineIdFromMovie(movie);
      if (allocineId) {
        batchEntries.push({ allocineId, expectedYear: releaseYear(movie), movie });
      } else {
        remaining.push(movie);
      }
    }

    if (batchEntries.length > 0) {
      debug(`phase 1a: batch SPARQL for ${batchEntries.length} films`);
      const batchResults = await findByAllocineIdsBatch(
        batchEntries.map((e) => ({ allocineId: e.allocineId, expectedYear: e.expectedYear })),
      );
      debug(`phase 1a: batch returned ${batchResults.size}/${batchEntries.length} results`);

      for (const entry of batchEntries) {
        const found = batchResults.get(entry.allocineId);
        if (!found) {
          remaining.push(entry.movie);
          continue;
        }
        const result: IdsCacheEntry = {
          qid: found.qid,
          title: found.title,
          imdbId: found.imdbId,
          tmdbId: found.tmdbId,
          rtPath: found.rtPath,
          allocineId: found.allocineId ?? entry.allocineId,
        };
        const titleKey = `${normalizeTitle(entry.movie.title)}:${releaseYear(entry.movie) ?? ''}`;
        writeIdsCacheEntry(`allocine:${entry.allocineId}`, result);
        writeIdsCacheEntry(`title:${titleKey}`, result);
        applyIds(entry.movie, result);
        onUpdated(entry.movie);
        onImdbRating(entry.movie, result);
        ratingsQueue.push({ movie: entry.movie, ids: result });
      }
    }

    // Phase 1b: per-film title search
    if (remaining.length > 0) {
      debug(`phase 1b: per-film title search for ${remaining.length} films`);
    }
    const workers: Promise<void>[] = [];
    for (let i = 0; i < Math.min(MAX_CONCURRENCY, remaining.length); i++) {
      workers.push(processIdQueue(remaining, onUpdated, onProgress, onImdbRating, ratingsQueue));
    }
    await Promise.all(workers);
  },
};

// ── Per-film title search worker ───────────────────────────────────────────

async function processIdQueue(
  queue: Movie[],
  onUpdated: (movie: Movie) => void,
  onProgress: () => void,
  onImdbRating: (movie: Movie, ids: IdsCacheEntry) => void,
  ratingsQueue: ResolvedMovie[],
): Promise<void> {
  while (queue.length > 0) {
    if (isCancelled()) return;
    const movie = queue.shift();
    if (!movie) break;

    try {
      const allocineId = allocineIdFromMovie(movie);
      const titleKey = `${normalizeTitle(movie.title)}:${releaseYear(movie) ?? ''}`;
      const idsCacheKey = allocineId ? `allocine:${allocineId}` : `title:${titleKey}`;

      let ids = lookupCachedIds(movie);

      if (!ids) {
        const inflightKey = idsCacheKey;
        let inflight = inflightIds.get(inflightKey);
        if (!inflight) {
          debug(`wikidata lookup: "${movie.title}"`);
          inflight = (async () => {
            try {
              const found = await findMovieIds({
                title: movie.title,
                year: releaseYear(movie),
                allocineId,
              });
              if (!found) {
                debug(`  no match for "${movie.title}"`);
                return null;
              }
              if (
                !allocineId &&
                !isCoherentMovie(
                  { title: movie.title, year: releaseYear(movie) },
                  { title: found.title },
                )
              ) {
                debug(`  mismatch: expected "${movie.title}", got "${found.title}" — skipping`);
                return null;
              }
              const result: IdsCacheEntry = {
                qid: found.qid,
                title: found.title,
                imdbId: found.imdbId,
                tmdbId: found.tmdbId,
                rtPath: found.rtPath,
                allocineId: found.allocineId ?? allocineId,
              };
              // Only cache permanently if we found at least one useful ID.
              // If the entity has no imdb/rt/allocine IDs, don't cache —
              // the user might add them to Wikidata later (or the data
              // might not be complete yet). Re-checking each launch is
              // cheap (one wbsearchentities + one wbgetentities call).
              if (result.imdbId || result.rtPath || result.allocineId) {
                writeIdsCacheEntry(idsCacheKey, result);
                writeIdsCacheEntry(`title:${titleKey}`, result);
              } else {
                debug(
                  `  found QID ${result.qid} but no external IDs — not caching (may be incomplete)`,
                );
              }
              return result;
            } finally {
              inflightIds.delete(inflightKey);
            }
          })();
          inflightIds.set(inflightKey, inflight);
        }
        const result = await inflight;
        if (!result) {
          onProgress();
          continue;
        }
        ids = result;
      }

      applyIds(movie, ids);
      onUpdated(movie);
      onImdbRating(movie, ids);
      ratingsQueue.push({ movie, ids });
    } catch (err) {
      log.idResolver.warn(
        `[id-resolver] lookup failed for "${movie.title}":` +
          ' ' +
          (err instanceof Error ? err.message : String(err)),
      );
    }
  }
}
