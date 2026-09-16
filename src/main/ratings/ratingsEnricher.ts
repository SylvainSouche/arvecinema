import { app } from 'electron';
import path from 'path';
import fs from 'fs';
import type { Movie } from '../../shared/types';
import { findMovieIds } from './wikidataClient';
import { fetchAllocineRatings, searchAllocineByTitle } from './allocineClient';
import { fetchRtRatings } from './rottenTomatoesClient';
import { fetchImdbRating } from './imdbClient';

// ──────────────────────────────────────────────────────────────────────────
// Ratings enricher — progressive, with TTL-based cache separation.
//
// Two-tier cache:
//   1. ids-cache.json     — Wikidata IDs (qid, imdbId, rtPath, allocineId).
//      NO TTL — IDs never change. Permanent cache.
//   2. ratings-cache.json — Actual ratings (IMDB, AlloCiné, RT scores).
//      TTL = 24h. Ratings evolve as new reviews come in.
//
// This separation means:
//   - Wikidata lookup happens at most ONCE per film (ever, unless cache
//     invalidated by coherence check)
//   - Rating scraping happens at most once per 24h per film
// ──────────────────────────────────────────────────────────────────────────

const IDS_CACHE_FILE = 'ids-cache.json';
const RATINGS_CACHE_FILE = 'ratings-cache.json';
const RATINGS_TTL_MS = 24 * 60 * 60 * 1000;   // 24 hours
const MAX_CONCURRENCY = 4;

const DEBUG = process.env.ARVE_DEBUG === '1';
function debug(...args: unknown[]) { if (DEBUG) console.log('[ratings]', ...args); }

// ── In-flight deduplication ─────────────────────────────────────────────────
// When multiple workers process copies of the same film (e.g. at Mont-Blanc
// + Cluses), we must not fire 2 Wikidata lookups OR 2 ratings scrapes for
// the same film simultaneously.
const inflightIds = new Map<string, Promise<IdsCacheEntry | null>>();
const inflightRatings = new Map<string, Promise<RatingsCacheEntry>>();

// ── IDs cache (permanent) ──────────────────────────────────────────────────

interface IdsCacheEntry {
  qid: string;
  title: string;
  imdbId?: string;
  tmdbId?: string;
  rtPath?: string;
  allocineId?: string;
}

function idsCachePath(): string {
  return path.join(app.getPath('userData'), IDS_CACHE_FILE);
}

function readIdsCache(): Record<string, IdsCacheEntry> {
  try { return JSON.parse(fs.readFileSync(idsCachePath(), 'utf-8')); }
  catch { return {}; }
}

function writeIdsCache(cache: Record<string, IdsCacheEntry>): void {
  const dir = app.getPath('userData');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(idsCachePath(), JSON.stringify(cache, null, 2), { mode: 0o600 });
}

// ── Ratings cache (TTL 24h) ─────────────────────────────────────────────────

interface RatingsCacheEntry {
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

function ratingsCachePath(): string {
  return path.join(app.getPath('userData'), RATINGS_CACHE_FILE);
}

function readRatingsCache(): Record<string, RatingsCacheEntry> {
  try { return JSON.parse(fs.readFileSync(ratingsCachePath(), 'utf-8')); }
  catch { return {}; }
}

function writeRatingsCache(cache: Record<string, RatingsCacheEntry>): void {
  const dir = app.getPath('userData');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(ratingsCachePath(), JSON.stringify(cache, null, 2), { mode: 0o600 });
}

/** Is a ratings cache entry still fresh (within TTL)? */
function isFresh(entry: RatingsCacheEntry): boolean {
  if (!entry.fetchedAt) return false;
  const age = Date.now() - new Date(entry.fetchedAt).getTime();
  return age < RATINGS_TTL_MS;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function releaseYear(movie: Movie): number | undefined {
  if (!movie.release) return undefined;
  const y = new Date(movie.release).getUTCFullYear();
  return Number.isFinite(y) ? y : undefined;
}

function allocineIdFromMovie(movie: Movie): string | undefined {
  if (movie.id && /^\d+$/.test(movie.id)) return movie.id;
  return undefined;
}

function normalizeTitle(s: string): string {
  return s.toLowerCase()
    .replace(/[\u2018\u2019\u201b]/g, "'")   // normalize curly apostrophes to straight
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Check if a Wikidata result is coherent with the movie we're looking for.
 *  Verifies title match. Year disambiguation happens in the SPARQL query
 *  (findByAllocineId) and in the title search (findByTitle) where we can
 *  filter results by description year. */
function isCoherentMovie(
  movie: { title: string; year?: number },
  found: { title: string },
): boolean {
  return isCoherent(movie.title, found.title);
}

function isCoherent(expected: string, got: string): boolean {
  const a = normalizeTitle(expected);
  const b = normalizeTitle(got);
  if (!a || !b) return false;
  return a === b || a.startsWith(b) || b.startsWith(a)
    || levenshtein(a, b) <= Math.max(3, Math.floor(Math.max(a.length, b.length) * 0.2));
}

function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (!m) return n; if (!n) return m;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = Math.min(dp[i-1][j]+1, dp[i][j-1]+1, dp[i-1][j-1] + (a[i-1]===b[j-1]?0:1));
  return dp[m][n];
}

// ── Enrichment ──────────────────────────────────────────────────────────────

/** Two-phase enrichment:
 *
 *  Phase 1: Wikidata ID resolution (fast, parallel).
 *    For each movie, resolve its QID + external IDs (IMDB, RT, AlloCiné).
 *    As soon as IDs are known, send a partial `rating:updated` event so the
 *    UI can display the source icons (⭐ IMDB, 🍅 RT, ✍ AC) WITHOUT scores.
 *
 *  Phase 2: Rating scraping (slow, progressive, per-source).
 *    For each resolved movie, scrape AlloCiné + IMDB + RT in parallel.
 *    As each source completes, send another `rating:updated` event so the
 *    score appears progressively next to its icon.
 */
export function enrichWithRatings(
  movies: Movie[],
  onUpdated: (movie: Movie) => void,
): void {
  debug(`starting enrichment of ${movies.length} movies`);

  // Phase 1: resolve ALL Wikidata IDs first (fast).
  const idQueue = movies.slice();
  const ratingsQueue: { movie: Movie; ids: IdsCacheEntry }[] = [];

  const phase1Workers: Promise<void>[] = [];
  for (let i = 0; i < Math.min(MAX_CONCURRENCY, idQueue.length); i++) {
    phase1Workers.push(processIdQueue(idQueue, movies, onUpdated, ratingsQueue));
  }

  // Phase 2: once all IDs are resolved, start scraping ratings.
  Promise.all(phase1Workers).then(() => {
    debug(`phase 1 done: ${ratingsQueue.length} movies resolved, starting phase 2 (ratings)`);
    const phase2Queue = ratingsQueue.slice();
    const phase2Workers: Promise<void>[] = [];
    for (let i = 0; i < Math.min(MAX_CONCURRENCY, phase2Queue.length); i++) {
      phase2Workers.push(processRatingsQueue(phase2Queue, onUpdated));
    }
    return Promise.all(phase2Workers);
  }).then(() => {
    debug(`enrichment complete`);
  }).catch(err => {
    console.error('[ratings] enrichment error:', err);
  });
}

/** Phase 1: resolve Wikidata IDs for all movies. */
async function processIdQueue(
  queue: Movie[],
  _allMovies: Movie[],
  onUpdated: (movie: Movie) => void,
  ratingsQueue: { movie: Movie; ids: IdsCacheEntry }[],
): Promise<void> {
  while (queue.length > 0) {
    const movie = queue.shift();
    if (!movie) break;

    try {
      const allocineId = allocineIdFromMovie(movie);
      const titleKey = `${normalizeTitle(movie.title)}:${releaseYear(movie) ?? ''}`;
      const idsCacheKey = allocineId ? `allocine:${allocineId}` : `title:${titleKey}`;

      const idsCache = readIdsCache();
      let ids = idsCache[idsCacheKey] ?? idsCache[`title:${titleKey}`];

      if (!ids) {
        const inflightKey = idsCacheKey;
        let inflight = inflightIds.get(inflightKey);
        if (!inflight) {
          debug(`wikidata lookup: "${movie.title}" (allocine=${allocineId ?? 'none'})`);
          inflight = (async () => {
            try {
              const found = await findMovieIds({
                title: movie.title,
                year: releaseYear(movie),
                allocineId,
              });

              if (!found) {
                debug(`  wikidata: no match for "${movie.title}"`);
                return null;
              }

              if (!isCoherentMovie({ title: movie.title, year: releaseYear(movie) }, { title: found.title })) {
                debug(`  wikidata mismatch: expected "${movie.title}", got "${found.title}" — skipping`);
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

              const updated = readIdsCache();
              updated[idsCacheKey] = result;
              updated[`title:${titleKey}`] = result;
              writeIdsCache(updated);
              debug(`  wikidata: QID=${result.qid}, imdb=${result.imdbId ?? '-'}, rt=${result.rtPath ?? '-'}, allocine=${result.allocineId ?? '-'}`);

              return result;
            } finally {
              inflightIds.delete(inflightKey);
            }
          })();
          inflightIds.set(inflightKey, inflight);
        } else {
          debug(`wikidata: reusing in-flight lookup for "${movie.title}"`);
        }

        const result = await inflight;
        if (!result) continue;
        ids = result;
      } else {
        debug(`ids cache hit: "${movie.title}" → QID=${ids.qid}`);
      }

      // Apply IDs to the movie immediately + notify the UI so badges appear
      // (icons without scores yet).
      applyIds(movie, ids);
      onUpdated(movie);

      // Enqueue for Phase 2 (ratings scraping).
      ratingsQueue.push({ movie, ids });
    } catch (err) {
      console.warn(`[ratings] ID lookup failed for "${movie.title}":`, err);
    }
  }
}

/** Phase 2: scrape ratings for resolved movies. */
async function processRatingsQueue(
  queue: { movie: Movie; ids: IdsCacheEntry }[],
  onUpdated: (movie: Movie) => void,
): Promise<void> {
  while (queue.length > 0) {
    const item = queue.shift();
    if (!item) break;

    const { movie, ids } = item;

    try {
      const ratingsCache = readRatingsCache();
      const ratingsKey = ids.qid;
      const cachedRatings = ratingsCache[ratingsKey];

      if (cachedRatings && isFresh(cachedRatings)) {
        applyRatings(movie, ids, cachedRatings);
        onUpdated(movie);
        debug(`ratings cache hit (fresh): "${movie.title}"`);
        continue;
      }

      // Cache miss or expired → check if another worker is already fetching.
      let inflightRating = inflightRatings.get(ratingsKey);
      if (!inflightRating) {
        debug(`fetching ratings for "${movie.title}" (QID=${ids.qid})`);
        inflightRating = (async (): Promise<RatingsCacheEntry> => {
          const entry: RatingsCacheEntry = { fetchedAt: new Date().toISOString() };
          try {
            // AlloCiné
            let acId = ids.allocineId;
            if (!acId) {
              debug(`  allocine: no ID — searching by title`);
              acId = (await searchAllocineByTitle(movie.title)) ?? undefined;
            }
            if (acId) {
              debug(`  allocine: scraping cfilm=${acId}`);
              const ac = await fetchAllocineRatings(acId);
              if (ac) {
                entry.allocinePress = ac.pressRating;
                entry.allocineAudience = ac.audienceRating;
                entry.allocineVotes = ac.audienceVotes;
                entry.allocineUrl = ac.url;
                entry.allocineStatus = ac.status;
                entry.allocineStatusMessage = ac.statusMessage;
                debug(`  allocine: press=${ac.pressRating ?? '-'}, audience=${ac.audienceRating ?? '-'}, status=${ac.status}`);

                // Notify immediately — AlloCiné score is ready, IMDB/RT still pending.
                applyRatings(movie, ids, entry);
                onUpdated(movie);
              }
            } else {
              entry.allocineStatus = 'absent';
              entry.allocineStatusMessage = 'Pas d\'ID AlloCiné trouvé';
            }

            // IMDB
            if (ids.imdbId) {
              debug(`  imdb: loading page ${ids.imdbId}`);
              const imdb = await fetchImdbRating(ids.imdbId);
              if (imdb) {
                entry.imdbRating = imdb.rating;
                entry.imdbVotes = imdb.votes;
                entry.imdbUrl = imdb.url;
                entry.imdbStatus = imdb.status;
                entry.imdbStatusMessage = imdb.statusMessage;
                debug(`  imdb: rating=${imdb.rating ?? '-'}, votes=${imdb.votes ?? '-'}, status=${imdb.status}`);

                // Notify — IMDB score is ready.
                applyRatings(movie, ids, entry);
                onUpdated(movie);
              }
            } else {
              entry.imdbStatus = 'absent';
              entry.imdbStatusMessage = 'Pas d\'ID IMDB sur Wikidata';
            }

            // RT
            if (ids.rtPath) {
              debug(`  rt: scraping ${ids.rtPath}`);
              const rt = await fetchRtRatings(ids.rtPath);
              if (rt) {
                entry.rtTomatometer = rt.tomatometer;
                entry.rtCertifiedFresh = rt.certifiedFresh;
                entry.rtUrl = rt.url;
                entry.rtStatus = rt.status;
                entry.rtStatusMessage = rt.statusMessage;
                debug(`  rt: tomatometer=${rt.tomatometer ?? '-'}, status=${rt.status}`);
              }
            } else {
              entry.rtStatus = 'absent';
              entry.rtStatusMessage = 'Pas de path RT sur Wikidata';
            }

            // Write ratings cache
            const updatedRatings = readRatingsCache();
            updatedRatings[ratingsKey] = entry;
            writeRatingsCache(updatedRatings);
          } finally {
            inflightRatings.delete(ratingsKey);
          }
          return entry;
        })();
        inflightRatings.set(ratingsKey, inflightRating);
      } else {
        debug(`ratings: reusing in-flight fetch for "${movie.title}" (QID=${ids.qid})`);
      }

      const entry = await inflightRating;

      applyRatings(movie, ids, entry);
      onUpdated(movie);
      debug(`  done: "${movie.title}"`);
    } catch (err) {
      console.warn(`[ratings] enrichment failed for "${movie.title}":`, err);
    }
  }
}

/** Apply Wikidata IDs to a movie (Phase 1 — before ratings are scraped).
 *  This sets imdbId, imdbUrl, allocineUrl, rtUrl, wikidataUrl so the UI
 *  can display the source icons immediately. */
function applyIds(movie: Movie, ids: IdsCacheEntry): void {
  Object.assign(movie, {
    imdbId: ids.imdbId,
    imdbUrl: ids.imdbId ? `https://www.imdb.com/title/${ids.imdbId}/` : undefined,
    allocineId: ids.allocineId,
    allocineUrl: ids.allocineId ? `https://www.allocine.fr/film/fichefilm_gen_cfilm=${ids.allocineId}.html` : undefined,
    rtUrl: ids.rtPath ? `https://www.rottentomatoes.com/${ids.rtPath}` : undefined,
    wikidataUrl: `https://www.wikidata.org/wiki/${ids.qid}`,
    // Mark all sources as "not yet fetched" — the UI will show the icon
    // but no score.
    imdbStatus: undefined,
    allocineStatus: undefined,
    rtStatus: undefined,
  });
}

function applyRatings(movie: Movie, ids: IdsCacheEntry, ratings: RatingsCacheEntry): void {
  Object.assign(movie, {
    imdbId: ids.imdbId,
    imdbRating: ratings.imdbRating,
    imdbVotes: ratings.imdbVotes,
    imdbUrl: ratings.imdbUrl ?? (ids.imdbId ? `https://www.imdb.com/title/${ids.imdbId}/` : undefined),
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
