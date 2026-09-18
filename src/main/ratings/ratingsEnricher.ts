import type { Movie } from '../../shared/types';
import { BrowserWindow } from 'electron';
import { findMovieIds, findByAllocineIdsBatch } from './wikidataClient';
import { fetchAllocineRatings, searchAllocineByTitle } from './allocineClient';
import { fetchRtRatings } from './rottenTomatoesClient';
import {
  initDataset,
  getRatingsByTconst,
  isDatasetLoaded,
  onDatasetRefreshed,
} from './imdbDatasetClient';
import {
  getIdsCacheEntry,
  getIdsCacheEntryByTitleKey,
  getIdsCacheEntriesByTitlePrefix,
  upsertIdsCacheEntry,
  getRatingsCacheEntry,
  upsertRatingsCacheEntry,
  type IdsCacheRow,
  type RatingsCacheRow,
} from './cacheDb';
import { isCancelled } from './shutdown';

// Note: imdbClient.ts (browserFetch HTML scraper) and imdbGraphqlClient.ts
// (GraphQL probe) are intentionally NOT imported here. They remain in the
// file tree as a sleeping backup in case the dataset approach becomes
// unavailable in the future. See those files' deprecation headers.

// ──────────────────────────────────────────────────────────────────────────
// Ratings enricher — progressive, with SQLite-backed caching.
//
// All caches live in a single SQLite file (`cache.db` in the user data dir):
//   1. `ids_cache` table    — Wikidata IDs (qid, imdbId, rtPath, allocineId).
//      NO TTL — IDs never change. Permanent cache.
//   2. `ratings_cache` table — Actual ratings (IMDB, AlloCiné, RT scores).
//      TTL = 24h. Ratings evolve as new reviews come in.
//   3. `imdb_ratings` table — IMDB dataset (1.71M rows), 36h refresh, see
//      `imdbDatasetClient.ts`.
//
// Old JSON cache files (`ids-cache.json`, `ratings-cache.json`, `imdb-ratings.db`)
// are auto-migrated to SQLite on first launch (see `cacheDb.migrateJsonCaches`).
//
// **Cache bypass (development / debugging):** setting `ARVE_NO_CACHE=1`
// bypasses all cache reads (returns null) AND writes (no-ops). Useful for
// testing the full pipeline from scratch.
//
// **IMDB ratings source:** uses the official IMDB public dataset
// (https://datasets.imdbws.com/title.ratings.tsv.gz) — SQLite-cached,
// refreshed in the background, no scraping of imdb.com.
// ──────────────────────────────────────────────────────────────────────────

const RATINGS_TTL_MS = 24 * 60 * 60 * 1000;   // 24 hours
const MAX_CONCURRENCY = 4;

const DEBUG = process.env.ARVE_DEBUG === '1';
const NO_CACHE = process.env.ARVE_NO_CACHE === '1';

/** Format a timestamp for debug logs: HH:MM:ss.sss */
function ts(): string {
  const d = new Date();
  return d.toLocaleTimeString('en-GB', { hour12: false }) + '.' + String(d.getMilliseconds()).padStart(3, '0');
}

function debug(...args: unknown[]) { if (DEBUG) console.log(`[${ts()}] [ratings]`, ...args); }

// ── Progress tracking ──────────────────────────────────────────────────────
//
// Counts how many films have been fully processed (have at least all
// attempted ratings applied). Broadcast to all renderer windows so the UI
// can show a bottom progress bar (X/Y films enriched).
//
// The `total` is set once at the start of enrichment (number of movies).
// The `resolved` counter increments each time a film is fully processed
// in Phase 2 (either scraped, or skipped because cache hit + fresh).
//
// When `resolved === total`, enrichment is done — the UI hides the bar.

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
  // Broadcast to all renderer windows — there's only one (the main app
  // window), but iterating is cheap and future-proof.
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('ratings:progress', {
      resolved: progressResolved,
      total: progressTotal,
      pct: progressTotal > 0 ? Math.round((progressResolved / progressTotal) * 100) : 0,
    });
  }
}

/** Format a duration in ms for log output: 1234 → "1.2s", 45 → "45ms". */
function fmtMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/** Wrap a sync function call with timing logs. Returns the call's result. */
function timedSync<T>(label: string, fn: () => T): T {
  if (!DEBUG) return fn();
  const start = performance.now();
  const result = fn();
  const elapsed = performance.now() - start;
  debug(`  ${label}: ${fmtMs(elapsed)}`);
  return result;
}

/** Wrap an async function call with timing logs. Returns a Promise of the
 *  call's result. */
async function timedAsync<T>(label: string, fn: () => Promise<T>): Promise<T> {
  if (!DEBUG) return fn();
  const start = performance.now();
  try {
    return await fn();
  } finally {
    const elapsed = performance.now() - start;
    debug(`  ${label}: ${fmtMs(elapsed)}`);
  }
}

// ── In-flight deduplication ─────────────────────────────────────────────────
// When multiple workers process copies of the same film (e.g. at Mont-Blanc
// + Cluses), we must not fire 2 Wikidata lookups OR 2 ratings scrapes for
// the same film simultaneously.
const inflightIds = new Map<string, Promise<IdsCacheEntry | null>>();
const inflightRatings = new Map<string, Promise<RatingsCacheEntry>>();

// ── IDs cache (permanent, SQLite-backed) ───────────────────────────────────

interface IdsCacheEntry {
  qid: string;
  title: string;
  imdbId?: string;
  tmdbId?: string;
  rtPath?: string;
  allocineId?: string;
}

/** Convert a SQLite row to the IdsCacheEntry shape used internally. */
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

/** Look up an IDs cache entry by its cache_key. Returns null if not found
 *  (or if ARVE_NO_CACHE=1 is set). */
function readIdsCacheEntry(cacheKey: string): IdsCacheEntry | null {
  if (NO_CACHE) {
    if (DEBUG) console.log('[ratings] ids cache: bypassed (ARVE_NO_CACHE=1)');
    return null;
  }
  return timedSync(`ids cache read [${cacheKey.substring(0, 50)}]`, () =>
    rowToIdsEntry(getIdsCacheEntry(cacheKey)),
  );
}

/** Look up by title key (secondary lookup path). */
function readIdsCacheEntryByTitle(titleKey: string): IdsCacheEntry | null {
  if (NO_CACHE) return null;
  return timedSync(`ids cache read by-title [${titleKey.substring(0, 50)}]`, () =>
    rowToIdsEntry(getIdsCacheEntryByTitleKey(titleKey)),
  );
}

/** Cross-cinema cache sharing: when a cinema has no allocine ID and no
 *  release year (e.g. Chamonix's cineVox adapter), the title cache key is
 *  `title:NORMALIZED:` (empty year). Another cinema (e.g. Mont-Blanc's
 *  boxOfficeApi adapter) may have already resolved the same film with a
 *  year: `title:NORMALIZED:2026`. This function searches for any cache
 *  entry with the same normalized title, regardless of year.
 *
 *  Returns the entry if exactly one match is found (unambiguous). Returns
 *  null if zero matches (truly unknown) or multiple matches (ambiguous —
 *  can't safely pick one without a year). */
function readIdsCacheEntryByTitleCrossCinema(normalizedTitle: string): IdsCacheEntry | null {
  if (NO_CACHE) return null;
  return timedSync(`ids cache cross-cinema [${normalizedTitle.substring(0, 40)}]`, () => {
    const rows = getIdsCacheEntriesByTitlePrefix(normalizedTitle);
    if (rows.length === 0) return null;
    if (rows.length === 1) {
      debug(`cross-cinema cache hit: "${normalizedTitle}" → QID=${rows[0].qid} (from another cinema)`);
      return rowToIdsEntry(rows[0]);
    }
    // Multiple matches — ambiguous, can't pick safely without a year.
    if (DEBUG) {
      debug(`cross-cinema cache ambiguous: "${normalizedTitle}" → ${rows.length} candidates (need year to disambiguate)`);
    }
    return null;
  });
}

/** Insert or replace an IDs cache entry. No-op when ARVE_NO_CACHE=1. */
function writeIdsCacheEntry(cacheKey: string, entry: IdsCacheEntry): void {
  if (NO_CACHE) return;
  timedSync(`ids cache write [${cacheKey.substring(0, 50)}]`, () => {
    upsertIdsCacheEntry({
      cache_key: cacheKey,
      qid: entry.qid,
      title: entry.title,
      imdb_id: entry.imdbId ?? null,
      tmdb_id: entry.tmdbId ?? null,
      rt_path: entry.rtPath ?? null,
      allocine_id: entry.allocineId ?? null,
    });
  });
}

// ── Ratings cache (TTL 24h, SQLite-backed) ─────────────────────────────────

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

/** Convert a SQLite row to the RatingsCacheEntry shape used internally. */
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

/** Read a ratings cache entry by QID. Returns null if not found (or if
 *  ARVE_NO_CACHE=1 is set). */
function readRatingsCacheEntry(qid: string): RatingsCacheEntry | null {
  if (NO_CACHE) {
    if (DEBUG) console.log('[ratings] ratings cache: bypassed (ARVE_NO_CACHE=1)');
    return null;
  }
  return rowToRatingsEntry(getRatingsCacheEntry(qid));
}

/** Insert or replace a ratings cache entry. No-op when ARVE_NO_CACHE=1. */
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

/** Is a ratings cache entry still fresh (within TTL)?
 *  Always returns false when ARVE_NO_CACHE=1.
 *
 *  CRITICAL: an entry is only "fresh" if ALL sources have been attempted
 *  (status is set, not undefined). Phase 1.5 writes IMDB data with a fresh
 *  `fetched_at` — if we only checked the timestamp, Phase 2 would skip
 *  AlloCiné + RT scraping entirely (regression observed in 0.6.0). By
 *  also requiring `allocineStatus` and `rtStatus` to be non-undefined,
 *  we ensure Phase 2 always runs for entries that haven't been fully
 *  scraped yet, while still short-circuiting entries that have. */
function isFresh(entry: RatingsCacheEntry | null): boolean {
  if (NO_CACHE || !entry) return false;
  if (!entry.fetchedAt) return false;
  const age = Date.now() - new Date(entry.fetchedAt).getTime();
  if (age >= RATINGS_TTL_MS) return false;
  // All sources must have been attempted (status is set).
  // `imdbStatus` may legitimately be undefined if the dataset hasn't
  // loaded yet — but the refresh callback handles that case separately.
  // For AC and RT, undefined means "Phase 2 hasn't run yet".
  if (entry.allocineStatus === undefined) return false;
  if (entry.rtStatus === undefined) return false;
  return true;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function releaseYear(movie: Movie): number | undefined {
  if (!movie.release) return undefined;
  const y = new Date(movie.release).getUTCFullYear();
  return Number.isFinite(y) ? y : undefined;
}

/** Extract the AlloCiné numeric ID from a movie.
 *  Only the boxOfficeApi adapter (Mont-Blanc, Cluses) returns real AlloCiné
 *  IDs as the movie's `id` field. The cineVox adapter (Chamonix) returns
 *  its own internal IDs (which happen to be numeric but are NOT AlloCiné
 *  IDs), and the cineChateau adapter (Bonneville) returns cotecine.fr
 *  internal IDs. Using these as AlloCiné IDs causes phantom cache keys
 *  and failed Wikidata SPARQL lookups by AlloCiné ID. */
const CINEMAS_WITH_REAL_ALLOCINE_IDS = new Set(['mont-blanc', 'cluses', 'bonneville']);

function allocineIdFromMovie(movie: Movie): string | undefined {
  // Only treat movie.id as an AlloCiné ID for cinemas that actually
  // return AlloCiné IDs (boxOfficeApi adapter).
  if (!CINEMAS_WITH_REAL_ALLOCINE_IDS.has(movie.cinemaId)) return undefined;
  if (movie.id && /^\d+$/.test(movie.id)) return movie.id;
  return undefined;
}

function normalizeTitle(s: string): string {
  return s.toLowerCase()
    .replace(/[\u2018\u2019\u201b]/g, "'")   // normalize curly apostrophes to straight
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    // Strip subtitle markers that don't change the film's identity:
    //   " - partie 1 : L'Âge de Fer"  →  " : l age de fer"
    //   "Partie 2 : J'écris ton nom"  →  "j ecris ton nom"
    //   "Final Cut" / "Extended" / "Version Longue" suffixes  →  removed
    .replace(/\s*[-:]\s*partie\s+\d+\s*[:\-]?\s*/g, ' ')
    .replace(/\s*[-:]\s*part\s+\d+\s*[:\-]?\s*/g, ' ')
    .replace(/\s+final\s*cut\s*$/i, '')
    .replace(/\s+extended\s*$/i, '')
    .replace(/\s+version\s+longue\s*$/i, '')
    .replace(/\s+version\s+courte\s*$/i, '')
    .replace(/\s*[:\-]\s*/g, ' ')   // treat ":" and "-" as word separators
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
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
  if (a === b) return true;
  // Prefix match in either direction (catches "Cars" vs "Cars 3", or
  // "Heart of the Beast" vs "Heart of the Beast 2")
  if (a.startsWith(b) || b.startsWith(a)) return true;
  // Token-subset match: if one title's tokens are a subset of the other's,
  // accept it. Catches "La Bataille de Gaulle L Âge de fer" vs
  // "La Bataille de Gaulle partie 1 L Âge de fer" (after normalize, partie
  // N is stripped) — but also catches "Spider Man" vs "Spider Man Brand
  // New Day" if the user wants the original film and Wikidata returns the
  // sequel. We require all tokens of the SHORTER title to appear in the
  // longer one (case-insensitive, accent-insensitive — already normalized).
  const aTokens = a.split(' ').filter(t => t.length > 2);
  const bTokens = b.split(' ').filter(t => t.length > 2);
  const [shorter, longer] = aTokens.length <= bTokens.length ? [aTokens, bTokens] : [bTokens, aTokens];
  if (shorter.length >= 3) {
    const longerSet = new Set(longer);
    const allPresent = shorter.every(t => longerSet.has(t));
    if (allPresent) return true;
  }
  // Fuzzy match with a more generous threshold (25% instead of 20%) to
  // absorb typos and small variations like "L'Âge de Fer" vs "l age de fer".
  return levenshtein(a, b) <= Math.max(3, Math.floor(Math.max(a.length, b.length) * 0.25));
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

/** Three-phase enrichment:
 *
 *  Phase 1: Wikidata ID resolution (fast, parallel).
 *    For each movie, resolve its QID + external IDs (IMDB, RT, AlloCiné).
 *    As soon as IDs are known, send a partial `rating:updated` event so the
 *    UI can display the source icons (⭐ IMDB, 🍅 RT, ✍ AC) WITHOUT scores.
 *
 *  Phase 1.5: IMDB dataset lookup (instant).
 *    Look up each movie's IMDB ID in the local SQLite dataset
 *    (downloaded + refreshed in the background by imdbDatasetClient).
 *    Sync query — no network calls, sub-millisecond per ID.
 *
 *  Phase 2: AlloCiné + RT scraping (slow, per-source, parallel).
 *    For each resolved movie, scrape AlloCiné + RT via `browserFetch`.
 *    As each source completes, send another `rating:updated` event so the
 *    score appears progressively next to its icon.
 *
 *  IMDB ratings: sourced ONLY from the dataset. No HTML scraping, no
 *  GraphQL. If a film isn't in the dataset (very rare — typically a
 *  brand-new release within the last 24h before the daily refresh), it
 *  shows as "absent" until the next dataset refresh. When the refresh
 *  completes, all registered refresh callbacks fire — the enricher
 *  re-looks-up its movies and emits `rating:updated` for any that changed.
 */
export function enrichWithRatings(
  movies: Movie[],
  onUpdated: (movie: Movie) => void,
): Promise<void> {
  debug(`starting enrichment of ${movies.length} movies`);

  // Reset the progress counter.
  resetProgress(movies.length);

  // Initialize the IMDB dataset (opens SQLite, background refresh if stale).
  initDataset();

  // ── Phase 0: apply ALL cached values synchronously ────────────────────
  // Before any network calls, walk every movie and apply whatever we have
  // in the SQLite cache (IDs + ratings). This makes ratings appear
  // INSTANTLY on app launch for previously-cached films — no waiting for
  // Wikidata SPARQL or AlloCiné scraping.
  //
  // For each movie:
  //   1. Look up its IDs_cache entry (by allocine ID or title key).
  //   2. If found, apply the IDs immediately (imdbId, rtPath, etc.).
  //   3. Look up its ratings_cache entry (by QID).
  //   4. If found (even if stale), apply the ratings immediately.
  //   5. Fire `rating:updated` IPC so the UI shows the cached values.
  const phase0Start = Date.now();
  debug('phase 0: applying cached values');
  const phase0Resolved: { movie: Movie; ids: IdsCacheEntry }[] = [];
  let phase0CacheHits = 0;
  let phase0FreshHits = 0;

  for (const movie of movies) {
    const allocineId = allocineIdFromMovie(movie);
    const titleKey = `${normalizeTitle(movie.title)}:${releaseYear(movie) ?? ''}`;
    const idsCacheKey = allocineId ? `allocine:${allocineId}` : `title:${titleKey}`;

    // Try cache lookups in order: allocine ID → title+year → cross-cinema.
    let ids = readIdsCacheEntry(idsCacheKey)
      ?? readIdsCacheEntryByTitle(titleKey)
      ?? readIdsCacheEntryByTitleCrossCinema(normalizeTitle(movie.title));

    if (!ids) continue;  // No cached IDs — will be resolved in Phase 1.

    // Apply IDs immediately so UI shows the source icons.
    applyIds(movie, ids);
    onUpdated(movie);
    phase0Resolved.push({ movie, ids });

    // Try to apply cached ratings too (even if stale — better than nothing).
    const cachedRatings = readRatingsCacheEntry(ids.qid);
    if (cachedRatings) {
      applyRatings(movie, ids, cachedRatings);
      onUpdated(movie);
      phase0CacheHits++;
      // If the cache is FRESH (all sources attempted, within TTL),
      // count this movie as fully resolved — Phase 2 will skip it.
      if (isFresh(cachedRatings)) {
        incrementProgress();
        phase0FreshHits++;
      }
    }

    // ── Also check IMDB dataset directly ────────────────────────────────
    // Even if ratings_cache had no imdb_rating (e.g. the dataset was
    // populated after the last ratings_cache write), check the imdb_ratings
    // table directly. This ensures IMDB ratings appear simultaneously with
    // AC/RT on the first run after cache population.
    if (ids.imdbId && movie.imdbRating === undefined) {
      const imdbEntry = getRatingsByTconst([ids.imdbId]).get(ids.imdbId);
      if (imdbEntry) {
        // Merge into the cached ratings (or create a new entry).
        const entry = cachedRatings ?? { fetchedAt: new Date().toISOString() };
        entry.imdbRating = imdbEntry.rating;
        entry.imdbVotes = imdbEntry.votes;
        entry.imdbUrl = `https://www.imdb.com/title/${ids.imdbId}/`;
        entry.imdbStatus = 'ok';
        entry.imdbStatusMessage = undefined;
        // Don't update fetched_at — that would make stale entries look fresh.
        // Only Phase 2 (which completes all sources) should update fetched_at.
        writeRatingsCacheEntry(ids.qid, entry);
        applyRatings(movie, ids, entry);
        onUpdated(movie);
      }
    }
  }
  const phase0Elapsed = Date.now() - phase0Start;
  debug(`phase 0 done in ${phase0Elapsed}ms: ${phase0Resolved.length}/${movies.length} IDs cached, ${phase0CacheHits} ratings cached (${phase0FreshHits} fresh → skip Phase 2)`);

  // ── Dataset refresh callback (same as before) ──────────────────────────
  onDatasetRefreshed(() => {
    debug('dataset refreshed — re-applying IMDB ratings');
    let changedCount = 0;
    for (const movie of movies) {
      if (!movie.imdbId) continue;
      const entry = getRatingsByTconst([movie.imdbId]).get(movie.imdbId);
      if (!entry) continue;
      const qid = findQidForMovie(movie);
      if (!qid) continue;
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
    if (changedCount > 0) {
      debug(`applied ${changedCount} updated IMDB ratings after refresh`);
    }
  });

  // ── Phase 1: resolve Wikidata IDs for movies NOT resolved in Phase 0 ──
  // Only movies that didn't have a cache hit need network lookups.
  const unresolvedMovies = movies.filter(m =>
    !phase0Resolved.some(r => r.movie === m),
  );
  debug(`phase 1: resolving ${unresolvedMovies.length} unresolved movies via Wikidata (parallel ×${MAX_CONCURRENCY})`);

  // ── Phase 1a: batch SPARQL for all films with AlloCiné IDs ─────────────
  // Instead of firing one SPARQL query per film (which triggers Wikidata's
  // rate limiting — HTTP 429), we batch up to 50 AlloCiné IDs into a
  // single SPARQL query using the VALUES clause. This reduces 20+ queries
  // to 1.
  const idQueue = unresolvedMovies.slice();
  // The ratingsQueue starts with Phase 0 hits (they already have IDs,
  // just need ratings if their cache was stale or missing).
  const ratingsQueue: { movie: Movie; ids: IdsCacheEntry }[] = phase0Resolved.slice();
  const phase1Start = Date.now();

  // Collect films with AlloCiné IDs for batch lookup.
  const batchEntries: Array<{ allocineId: string; expectedYear?: number; movie: Movie }> = [];
  const remainingQueue: Movie[] = [];

  for (const movie of idQueue) {
    const allocineId = allocineIdFromMovie(movie);
    if (allocineId) {
      batchEntries.push({
        allocineId,
        expectedYear: releaseYear(movie),
        movie,
      });
    } else {
      // No AlloCiné ID — will be resolved via title search in Phase 1b.
      remainingQueue.push(movie);
    }
  }

  if (remainingQueue.length > 0) {
    debug(`phase 1b: per-film title search for ${remainingQueue.length} remaining films`);
  }
  const phase1bQueue = remainingQueue;
  let phase2Start = 0;

  // Run Phase 1a (batch) + Phase 1b (per-film) + Phase 1.5 + Phase 2.
  return (async () => {
    // ── Phase 1a: batch SPARQL for all films with AlloCiné IDs ─────────
    if (batchEntries.length > 0) {
      debug(`phase 1a: batch SPARQL for ${batchEntries.length} films with AlloCiné IDs`);
      const batchResults = await findByAllocineIdsBatch(
        batchEntries.map(e => ({ allocineId: e.allocineId, expectedYear: e.expectedYear })),
      );
      debug(`phase 1a: batch returned ${batchResults.size}/${batchEntries.length} results`);

      // Apply batch results + cache them.
      for (const entry of batchEntries) {
        const found = batchResults.get(entry.allocineId);
        if (!found) {
          // Not found in batch — add to remaining queue for title search.
          phase1bQueue.push(entry.movie);
          continue;
        }

        // No coherence check for batch lookups — the AlloCiné ID (P1265)
        // is a unique identifier on Wikidata. If it matched, it's the right
        // film, even if the Wikidata label is in English ("The Invite")
        // while the cinema uses the French title ("L'Invitation").

        const result: IdsCacheEntry = {
          qid: found.qid,
          title: found.title,
          imdbId: found.imdbId,
          tmdbId: found.tmdbId,
          rtPath: found.rtPath,
          allocineId: found.allocineId ?? entry.allocineId,
        };

        // Cache under both keys.
        const titleKey = `${normalizeTitle(entry.movie.title)}:${releaseYear(entry.movie) ?? ''}`;
        writeIdsCacheEntry(`allocine:${entry.allocineId}`, result);
        writeIdsCacheEntry(`title:${titleKey}`, result);
        debug(`  wikidata: QID=${result.qid}, imdb=${result.imdbId ?? '-'}, rt=${result.rtPath ?? '-'}, allocine=${result.allocineId ?? '-'}`);

        // Apply IDs + incremental IMDB dataset lookup.
        applyIds(entry.movie, result);
        onUpdated(entry.movie);

        if (result.imdbId) {
          const imdbEntry = getRatingsByTconst([result.imdbId]).get(result.imdbId);
          if (imdbEntry) {
            const existing = readRatingsCacheEntry(result.qid) ?? { fetchedAt: new Date().toISOString() };
            existing.imdbRating = imdbEntry.rating;
            existing.imdbVotes = imdbEntry.votes;
            existing.imdbUrl = `https://www.imdb.com/title/${result.imdbId}/`;
            existing.imdbStatus = 'ok';
            existing.imdbStatusMessage = undefined;
            existing.fetchedAt = new Date().toISOString();
            writeRatingsCacheEntry(result.qid, existing);
            applyRatings(entry.movie, result, existing);
            onUpdated(entry.movie);
            debug(`  imdb: dataset rating ${imdbEntry.rating} applied immediately`);
          }
        }

        ratingsQueue.push({ movie: entry.movie, ids: result });
      }
    }

    // ── Phase 1b: per-film title search for films without AlloCiné IDs ──
    const phase1Workers: Promise<void>[] = [];
    for (let i = 0; i < Math.min(MAX_CONCURRENCY, phase1bQueue.length); i++) {
      phase1Workers.push(processIdQueue(phase1bQueue, movies, onUpdated, ratingsQueue));
    }

    await Promise.all(phase1Workers);
    const phase1Elapsed = Date.now() - phase1Start;
    debug(`phase 1 done in ${phase1Elapsed}ms: ${ratingsQueue.length} movies have IDs (${unresolvedMovies.length} were resolved online)`);

      // ── Phase 1.5: batch IMDB dataset lookup ──────────────────────────
      // The IMDB dataset is stored in the shared SQLite `imdb_ratings` table
      // (refreshed daily by imdbDatasetClient in the background). Lookups
      // are sync SQL `SELECT WHERE tconst IN (...)` — sub-ms.
      //
      // We collect all unique IMDB IDs from movies that need ratings
      // (cache miss or expired), do a single batch lookup, and apply
      // the results immediately. Phase 2's per-film browserFetch is only
      // used for IDs the dataset doesn't have (very rare — recent
      // releases within last 24h).
      const imdbIdsToFetch: string[] = [];
      const movieByImdbId = new Map<string, { movie: Movie; ids: IdsCacheEntry }>();

      for (const item of ratingsQueue) {
        const cached = readRatingsCacheEntry(item.ids.qid);
        if (cached && isFresh(cached)) continue; // already fresh
        if (!item.ids.imdbId) continue;
        if (movieByImdbId.has(item.ids.imdbId)) continue; // dedupe
        movieByImdbId.set(item.ids.imdbId, item);
        imdbIdsToFetch.push(item.ids.imdbId);
      }

      if (imdbIdsToFetch.length > 0) {
        debug(
          `phase 1.5: looking up ${imdbIdsToFetch.length} IMDB IDs in dataset`,
        );
        try {
          const datasetResults = timedSync(
            `phase 1.5: dataset batch lookup (${imdbIdsToFetch.length} IDs)`,
            () => getRatingsByTconst(imdbIdsToFetch),
          );
          debug(
            `phase 1.5: dataset returned ${datasetResults.size} results ` +
              `(of ${imdbIdsToFetch.length} requested)` +
              (isDatasetLoaded() ? '' : ' [dataset not loaded — fallback to scraping]'),
          );

          // Apply dataset results to movies + write to cache.
          for (const [imdbId, entry] of datasetResults) {
            const item = movieByImdbId.get(imdbId);
            if (!item) continue;
            const ratingsKey = item.ids.qid;
            const cached = readRatingsCacheEntry(ratingsKey) ?? {
              fetchedAt: new Date().toISOString(),
            };
            cached.imdbRating = entry.rating;
            cached.imdbVotes = entry.votes;
            cached.imdbUrl = `https://www.imdb.com/title/${imdbId}/`;
            cached.imdbStatus = 'ok';
            cached.imdbStatusMessage = undefined;
            cached.fetchedAt = new Date().toISOString();
            writeRatingsCacheEntry(ratingsKey, cached);

            // Apply + notify — IMDB score is ready.
            applyRatings(item.movie, item.ids, cached);
            onUpdated(item.movie);
          }

          // For IDs the dataset didn't have, mark as absent so Phase 2's
          // per-film browserFetch fallback can try them (rare: only for
          // brand-new releases within last 24h).
          for (const imdbId of imdbIdsToFetch) {
            if (!datasetResults.has(imdbId)) {
              const item = movieByImdbId.get(imdbId);
              if (!item) continue;
              const ratingsKey = item.ids.qid;
              const cached = readRatingsCacheEntry(ratingsKey) ?? {
                fetchedAt: new Date().toISOString(),
              };
              cached.imdbStatus = 'absent';
              cached.imdbStatusMessage = 'Not in IMDB dataset (released within last 24h?)';
              cached.imdbUrl = `https://www.imdb.com/title/${imdbId}/`;
              writeRatingsCacheEntry(ratingsKey, cached);
            }
          }
        } catch (err) {
          debug(
            `phase 1.5: dataset lookup failed entirely — Phase 2 will use browserFetch fallback. Reason: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }

      // ── Phase 2: per-film AlloCiné/RT scraping + IMDB fallback ────────
      // Sort the queue by NEXT SCREENING TIME (closest first) so the
      // displayed page updates first — the user sees ratings for films
      // showing today before films showing next week.
      const phase2Queue = ratingsQueue.slice().sort((a, b) => {
        const aTime = nextScreeningTime(a.movie);
        const bTime = nextScreeningTime(b.movie);
        if (aTime === null && bTime === null) return 0;
        if (aTime === null) return 1;   // no showtimes → sort last
        if (bTime === null) return -1;
        return aTime - bTime;
      });
      debug(`phase 2: per-film ratings (${phase2Queue.length} films, sorted by next screening)`);
      phase2Start = Date.now();
      const phase2Workers: Promise<void>[] = [];
      for (let i = 0; i < Math.min(MAX_CONCURRENCY, phase2Queue.length); i++) {
        phase2Workers.push(processRatingsQueue(phase2Queue, onUpdated));
      }
      await Promise.all(phase2Workers);
      const phase2Elapsed = Date.now() - phase2Start;
      debug(`phase 2 done in ${phase2Elapsed}ms: enrichment complete`);
    })();
}

/** Find the earliest future showtime for a movie. Returns the timestamp
 *  in ms, or null if the movie has no showtimes. Used to sort the Phase 2
 *  queue so films showing sooner are enriched first. */
function nextScreeningTime(movie: Movie): number | null {
  if (!movie.showtimes || movie.showtimes.length === 0) return null;
  const now = Date.now();
  // Find the earliest showtime that hasn't passed yet.
  let earliest: number | null = null;
  for (const s of movie.showtimes) {
    const t = new Date(s.time).getTime();
    if (Number.isNaN(t)) continue;
    if (t < now) continue;  // skip past showtimes
    if (earliest === null || t < earliest) earliest = t;
  }
  // If all showtimes are in the past, use the latest one (least stale).
  if (earliest === null) {
    for (const s of movie.showtimes) {
      const t = new Date(s.time).getTime();
      if (Number.isNaN(t)) continue;
      if (earliest === null || t > earliest) earliest = t;
    }
  }
  return earliest;
}

/** Phase 1: resolve Wikidata IDs for all movies. */
async function processIdQueue(
  queue: Movie[],
  _allMovies: Movie[],
  onUpdated: (movie: Movie) => void,
  ratingsQueue: { movie: Movie; ids: IdsCacheEntry }[],
): Promise<void> {
  while (queue.length > 0) {
    // Check for shutdown — if the app is closing, stop processing immediately.
    if (isCancelled()) return;
    const movie = queue.shift();
    if (!movie) break;

    try {
      const allocineId = allocineIdFromMovie(movie);
      const titleKey = `${normalizeTitle(movie.title)}:${releaseYear(movie) ?? ''}`;
      const idsCacheKey = allocineId ? `allocine:${allocineId}` : `title:${titleKey}`;

      // Per-entry SQLite lookup — no full-table read.
      // Chain: allocine-ID cache → title+year cache → cross-cinema title
      // cache (shares Wikidata results across cinemas when one has a year
      // and another doesn't).
      const normalized = normalizeTitle(movie.title);
      let ids = readIdsCacheEntry(idsCacheKey)
        ?? readIdsCacheEntryByTitle(titleKey)
        ?? readIdsCacheEntryByTitleCrossCinema(normalized);

      if (!ids) {
        const inflightKey = idsCacheKey;
        let inflight = inflightIds.get(inflightKey);
        if (!inflight) {
          debug(`wikidata lookup: "${movie.title}" (allocine=${allocineId ?? 'none'})`);
          inflight = (async () => {
            try {
              const found = await timedAsync(`  wikidata SPARQL lookup "${movie.title}"`, () =>
                findMovieIds({
                  title: movie.title,
                  year: releaseYear(movie),
                  allocineId,
                }),
              );

              if (!found) {
                debug(`  wikidata: no match for "${movie.title}"`);
                return null;
              }

              // Skip coherence check when the lookup was by AlloCiné ID —
              // the ID (P1265) is authoritative. Wikidata may return an
              // English label ("The Invite") for a French film ("L'Invitation").
              if (!allocineId) {
                if (!isCoherentMovie({ title: movie.title, year: releaseYear(movie) }, { title: found.title })) {
                  debug(`  wikidata mismatch: expected "${movie.title}", got "${found.title}" — skipping`);
                  return null;
                }
              }

              const result: IdsCacheEntry = {
                qid: found.qid,
                title: found.title,
                imdbId: found.imdbId,
                tmdbId: found.tmdbId,
                rtPath: found.rtPath,
                allocineId: found.allocineId ?? allocineId,
              };

              // Per-entry upserts — written immediately, no read-modify-write race.
              writeIdsCacheEntry(idsCacheKey, result);
              writeIdsCacheEntry(`title:${titleKey}`, result);
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
        if (!result) {
          // Wikidata couldn't resolve this film — still count it as
          // "processed" for the progress bar so the bar reaches 100%.
          incrementProgress();
          continue;
        }
        ids = result;
      } else {
        debug(`ids cache hit: "${movie.title}" → QID=${ids.qid}`);
      }

      // Apply IDs to the movie immediately + notify the UI so badges appear
      // (icons without scores yet).
      applyIds(movie, ids);
      onUpdated(movie);

      // ── Incremental IMDB dataset lookup ────────────────────────────────
      // As soon as we have the IMDB ID for this film, look it up in the
      // dataset IMMEDIATELY — don't wait for all other films to finish
      // Phase 1. This makes IMDB ratings appear within seconds of each
      // film's Wikidata resolution, not after all 60 films are done.
      if (ids.imdbId) {
        const imdbEntry = getRatingsByTconst([ids.imdbId]).get(ids.imdbId);
        if (imdbEntry) {
          // Apply IMDB rating immediately + write to cache + notify UI.
          const existing = readRatingsCacheEntry(ids.qid) ?? { fetchedAt: new Date().toISOString() };
          existing.imdbRating = imdbEntry.rating;
          existing.imdbVotes = imdbEntry.votes;
          existing.imdbUrl = `https://www.imdb.com/title/${ids.imdbId}/`;
          existing.imdbStatus = 'ok';
          existing.imdbStatusMessage = undefined;
          existing.fetchedAt = new Date().toISOString();
          writeRatingsCacheEntry(ids.qid, existing);
          applyRatings(movie, ids, existing);
          onUpdated(movie);
          debug(`  imdb: dataset rating ${imdbEntry.rating} applied immediately`);
        }
      }

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

    // Check for shutdown — if the app is closing, stop processing immediately.
    if (isCancelled()) return;

    const { movie, ids } = item;

    try {
      const ratingsKey = ids.qid;
      const cachedRatings = readRatingsCacheEntry(ratingsKey);

      if (cachedRatings && isFresh(cachedRatings)) {
        applyRatings(movie, ids, cachedRatings);
        onUpdated(movie);
        debug(`ratings cache hit (fresh): "${movie.title}"`);
        incrementProgress();
        continue;
      }

      // Cache miss or expired → check if another worker is already fetching.
      let inflightRating = inflightRatings.get(ratingsKey);
      if (!inflightRating) {
        debug(`fetching ratings for "${movie.title}" (QID=${ids.qid})`);
        inflightRating = (async (): Promise<RatingsCacheEntry> => {
          // Start from the existing cache entry (if any) so we PRESERVE
          // fields populated by other phases (e.g. IMDB from Phase 1.5).
          // This is critical: if we started from `{ fetchedAt: ... }` only,
          // our final writeRatingsCacheEntry() would clobber IMDB data with
          // null (because the entry object doesn't have imdb fields set).
          // With the ON CONFLICT DO UPDATE fix in cacheDb, this isn't
          // strictly required anymore (nulls preserve existing values), but
          // starting from the existing entry is still cleaner — we get a
          // correct `applyRatings` call immediately after each source
          // completes (not just at the end).
          const existing = readRatingsCacheEntry(ratingsKey);
          const entry: RatingsCacheEntry = existing ?? { fetchedAt: new Date().toISOString() };
          try {
            // AlloCiné
            let acId = ids.allocineId;
            if (!acId) {
              debug(`  allocine: no ID — searching by title`);
              acId = (await timedAsync(`  allocine search-by-title "${movie.title}"`, () =>
                searchAllocineByTitle(movie.title),
              )) ?? undefined;
            }
            if (acId) {
              debug(`  allocine: scraping cfilm=${acId}`);
              const ac = await timedAsync(`  allocine scrape [cfilm=${acId}]`, () =>
                fetchAllocineRatings(acId!),
              );
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
            // No per-film fetching — IMDB ratings come ONLY from the local
            // SQLite dataset (populated by imdbDatasetClient in the
            // background). The dataset is the single source of truth.
            //
            // Phase 1.5 already looked up this film's IMDB ID and either:
            //   - Set entry.imdbStatus='ok' with a rating → nothing to do
            //   - Set entry.imdbStatus='absent' (not in dataset) → trust it;
            //     will be re-tried automatically when the dataset refreshes
            //     (see the onDatasetRefreshed callback in enrichWithRatings)
            //   - Didn't set anything (dataset not loaded yet) → leave
            //     undefined; the refresh callback will fill it in later
            //
            // The previous browserFetch fallback (imdbClient.ts) is parked
            // as sleeping backup and is NOT imported here.
            if (ids.imdbId) {
              if (entry.imdbStatus === 'ok') {
                debug(`  imdb: dataset rating ${entry.imdbRating} (no per-film fetch)`);
              } else if (entry.imdbStatus === 'absent') {
                debug(`  imdb: not in dataset — will retry on next refresh`);
              } else {
                debug(`  imdb: dataset not loaded yet — pending refresh`);
              }
            } else {
              entry.imdbStatus = 'absent';
              entry.imdbStatusMessage = 'Pas d\'ID IMDB sur Wikidata';
            }

            // RT
            if (ids.rtPath) {
              debug(`  rt: scraping ${ids.rtPath}`);
              const rt = await timedAsync(`  rt scrape [${ids.rtPath}]`, () =>
                fetchRtRatings(ids.rtPath!),
              );
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

            // Write ratings cache (per-entry upsert)
            // Update fetched_at to NOW — all sources have been attempted
            // (status fields are set for AC and RT; IMDB was handled by
            // Phase 1.5 or remains undefined if dataset not loaded). The
            // next `isFresh` check will now pass and skip Phase 2 for this
            // entry until the TTL expires.
            entry.fetchedAt = new Date().toISOString();
            writeRatingsCacheEntry(ratingsKey, entry);
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
      incrementProgress();
    } catch (err) {
      console.warn(`[ratings] enrichment failed for "${movie.title}":`, err);
      incrementProgress();   // still count as "processed" so the bar advances
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

/** Extract the QID from a movie's `wikidataUrl` (e.g. "https://www.wikidata.org/wiki/Q12345" → "Q12345").
 *  Returns null if the URL is missing or doesn't contain a QID. */
function findQidForMovie(movie: Movie): string | null {
  if (!movie.wikidataUrl) return null;
  const m = movie.wikidataUrl.match(/\/(Q\d+)$/);
  return m ? m[1] : null;
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
