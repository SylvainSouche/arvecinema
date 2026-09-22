import { app } from 'electron';
import path from 'path';
import fs from 'fs';
import {
  readCredentials,
  computeSubscriptionHash,
  computeB64Username,
} from '../credentials';
import { fetchWithTimeout, REQUEST_TIMEOUT_MS } from '../../shared/fetchWithTimeout';

// ──────────────────────────────────────────────────────────────────────────
// MPDB.tv API client with persistent cache.
//
// Two-tier lookup:
//   1. Search by `id_allocine` (we have this from the boxofficeapi `altId`
//      field, which is the most reliable identifier for French films).
//   2. Fallback: search by title + year.
//
// Cache policy:
//   - Persistent on disk (JSON file in userData/ratings-cache.json).
//   - NO TTL — movie ratings are stable, so we never re-fetch a cached entry
//     unless the coherence check fails.
//   - Coherence check: after fetching, we verify the returned title and year
//     roughly match the expected movie. If they don't (e.g. the allocine ID
//     was reassigned, or the search returned the wrong film), we delete the
//     cache entry and return null rather than polluting the cache.
// ──────────────────────────────────────────────────────────────────────────

const CACHE_FILENAME = 'ratings-cache.json';
const MPDB_BASE = 'https://mpdb.tv/api/v1';

interface MpdbMovie {
  id: string;
  original_title?: string;
  title?: string;
  alternative?: string;
  year?: string | number;
  rating?: string | number;
  rating_votes?: string | number;
  plot?: string;
  runtime?: string | number;
  id_allocine?: string;
  id_imdb?: string;
  id_tmdb?: string;
  url?: string;          // e.g. "/movie/12701/view"
  posterUrl?: string;
}

interface CacheEntry {
  mpdbId: string;
  rating?: number;       // 0-10 (e.g. 7.7)
  ratingVotes?: number;
  title: string;
  year?: number;
  url?: string;          // full https URL to the MPDB movie page
  posterUrl?: string;
  fetchedAt: string;     // ISO timestamp — informational only, never used to invalidate
  source: 'allocine' | 'title-search';
}

interface CacheFile {
  // Keyed by `allocine:<id>` or `title:<normalized-title>:<year>`
  [cacheKey: string]: CacheEntry;
}

// ── Cache I/O ───────────────────────────────────────────────────────────────

function cachePath(): string {
  return path.join(app.getPath('userData'), CACHE_FILENAME);
}

function readCache(): CacheFile {
  try {
    const raw = fs.readFileSync(cachePath(), 'utf-8');
    return JSON.parse(raw) as CacheFile;
  } catch {
    return {};
  }
}

function writeCache(cache: CacheFile): void {
  const dir = app.getPath('userData');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(cachePath(), JSON.stringify(cache, null, 2), {
    encoding: 'utf-8',
    mode: 0o600,
  });
}

/** Remove a single cache entry (used by the coherence-check failure path). */
function evictFromCache(key: string): void {
  const cache = readCache();
  delete cache[key];
  writeCache(cache);
}

// ── URL building ───────────────────────────────────────────────────────────

function buildAuthSegments(creds: ReturnType<typeof readCredentials>): {
  apiKey: string; b64User: string; subHash: string;
} | null {
  if (!creds) return null;
  return {
    apiKey: creds.apiKey,
    b64User: computeB64Username(creds),
    subHash: computeSubscriptionHash(creds),
  };
}

// ── Coherence check ─────────────────────────────────────────────────────────

/** Normalize a title for fuzzy comparison: lowercase, strip accents, remove
 *  punctuation, collapse whitespace. */
function normalizeTitle(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Compare expected vs returned movie. Returns true if they're plausibly the
 *  same film. Used to detect a stale or mismatched cache entry. */
function isCoherent(
  expected: { title: string; year?: number },
  got: { title?: string; original_title?: string; year?: string | number },
): boolean {
  const gotTitle = normalizeTitle(got.title || got.original_title || '');
  const expTitle = normalizeTitle(expected.title);
  if (!gotTitle || !expTitle) return false;

  // Title match: either is a prefix of the other, or Levenshtein distance is
  // small relative to the longer title.
  const titleOk = gotTitle === expTitle
    || gotTitle.startsWith(expTitle) || expTitle.startsWith(gotTitle)
    || levenshtein(gotTitle, expTitle) <= Math.max(3, Math.floor(Math.max(gotTitle.length, expTitle.length) * 0.15));
  if (!titleOk) return false;

  // Year match (if both available): tolerate ±1 year (release vs festival dates).
  if (expected.year !== undefined && got.year !== undefined && got.year !== '') {
    const gotYear = Number(got.year);
    if (Number.isFinite(gotYear) && Math.abs(gotYear - expected.year) > 1) {
      return false;
    }
  }
  return true;
}

/** Tiny Levenshtein — no need to import a dependency for this. */
function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  return dp[m][n];
}

// ── API calls ──────────────────────────────────────────────────────────────

async function mpdbFetch<T>(segments: string[], params: Record<string, string> = {}): Promise<T | null> {
  const creds = readCredentials();
  const auth = buildAuthSegments(creds);
  if (!auth) return null;

  // MPDB's auth scheme: credentials go in the URL path, not as query params.
  // URL pattern: /api/v1/{action}/{apiKey}/{b64User}/{subHash}/{rest...}
  const allSegments = [segments[0], auth.apiKey, auth.b64User, auth.subHash, ...segments.slice(1)];
  const url = new URL(`${MPDB_BASE}/${allSegments.join('/')}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  if (!params._format) url.searchParams.set('_format', 'json');

  try {
    const res = await fetchWithTimeout(url.toString(), {
      headers: { Accept: 'application/json' },
    }, REQUEST_TIMEOUT_MS);
    if (!res.ok) {
      console.warn(`[mpdb] HTTP ${res.status} on ${url.toString()}`);
      return null;
    }
    const text = await res.text();
    // MPDB sometimes returns XML even when _format=json is requested — guard.
    if (text.startsWith('<?xml') || text.startsWith('<response')) {
      console.warn('[mpdb] got XML despite _format=json — endpoint may not support JSON');
      return null;
    }
    return JSON.parse(text) as T;
  } catch (err) {
    console.warn('[mpdb] fetch failed:', err);
    return null;
  }
}

// ── Public API ──────────────────────────────────────────────────────────────

export interface MpdbRating {
  mpdbId: string;
  rating?: number;        // 0-10
  ratingVotes?: number;
  url?: string;           // https://mpdb.tv/movie/<id>/view
  source: 'allocine' | 'title-search';
}

/** Look up ratings for a movie.
 *
 *  Strategy:
 *    1. If the movie has an AlloCiné ID (from boxofficeapi `altId`), use it
 *       as the lookup key — most reliable.
 *    2. Otherwise, search by title + year.
 *    3. Check the cache first (keyed by allocine ID or normalized title).
 *    4. On cache hit, return the cached entry — NO TTL, never invalidated
 *       by time.
 *    5. On cache miss, fetch from MPDB, run the coherence check, store.
 *    6. On coherence failure, evict the cache entry and return null.
 */
export async function fetchRating(movie: {
  title: string;
  year?: number;
  allocineId?: string;
}): Promise<MpdbRating | null> {
  const cacheKey = movie.allocineId
    ? `allocine:${movie.allocineId}`
    : `title:${normalizeTitle(movie.title)}:${movie.year ?? ''}`;
  const cache = readCache();

  // 1. Cache hit — return immediately, no TTL check.
  const cached = cache[cacheKey];
  if (cached) {
    return {
      mpdbId: cached.mpdbId,
      rating: cached.rating,
      ratingVotes: cached.ratingVotes,
      url: cached.url,
      source: cached.source,
    };
  }

  // 2. Cache miss — fetch from MPDB.
  let mpdbMovie: MpdbMovie | null = null;
  let source: 'allocine' | 'title-search' = 'title-search';

  if (movie.allocineId) {
    // Direct lookup by AlloCiné ID — typeId=allocine.
    const res = await mpdbFetch<{ response: MpdbMovie } | MpdbMovie>(['movies', movie.allocineId], {
      language: 'fr_fr',
      typeId: 'allocine',
      _format: 'json',
    });
    mpdbMovie = extractMovie(res);
    source = 'allocine';
  }

  if (!mpdbMovie) {
    // Fallback: search by title.
    const res = await mpdbFetch<{ response: { item: MpdbMovie[] } | MpdbMovie[] }>(
      ['search', 'movies', encodeURIComponent(movie.title)],
      { language: 'fr_fr', _format: 'json' },
    );
    mpdbMovie = pickBestSearchResult(res, movie);
    source = 'title-search';
  }

  if (!mpdbMovie) return null;

  // 3. Coherence check — verify the returned film matches what we asked for.
  if (!isCoherent(
    { title: movie.title, year: movie.year },
    { title: mpdbMovie.title, original_title: mpdbMovie.original_title, year: mpdbMovie.year },
  )) {
    console.warn(`[mpdb] coherence check failed for "${movie.title}" — got "${mpdbMovie.title}" (${mpdbMovie.year}). Evicting cache.`);
    evictFromCache(cacheKey);
    return null;
  }

  // 4. Cache the result (no TTL).
  const entry: CacheEntry = {
    mpdbId: String(mpdbMovie.id),
    rating: typeof mpdbMovie.rating === 'string' ? Number(mpdbMovie.rating) : mpdbMovie.rating,
    ratingVotes: typeof mpdbMovie.rating_votes === 'string' ? Number(mpdbMovie.rating_votes) : mpdbMovie.rating_votes,
    title: mpdbMovie.title || mpdbMovie.original_title || movie.title,
    year: mpdbMovie.year !== undefined && mpdbMovie.year !== '' ? Number(mpdbMovie.year) : undefined,
    url: mpdbMovie.url ? `https://mpdb.tv${mpdbMovie.url}` : `https://mpdb.tv/movie/${mpdbMovie.id}/view`,
    posterUrl: mpdbMovie.posterUrl,
    fetchedAt: new Date().toISOString(),
    source,
  };
  if (entry.rating !== undefined && !Number.isFinite(entry.rating)) entry.rating = undefined;
  if (entry.ratingVotes !== undefined && !Number.isFinite(entry.ratingVotes)) entry.ratingVotes = undefined;

  cache[cacheKey] = entry;
  writeCache(cache);

  return {
    mpdbId: entry.mpdbId,
    rating: entry.rating,
    ratingVotes: entry.ratingVotes,
    url: entry.url,
    source: entry.source,
  };
}

/** Test that the configured credentials work. Returns true if the API
 *  accepts them, false otherwise. Used by the Settings panel's "Test" button. */
export async function testCredentials(): Promise<{ ok: boolean; message: string }> {
  const creds = readCredentials();
  if (!creds) {
    return { ok: false, message: 'Aucun credential configuré' };
  }
  // Try a search request — searches don't consume the quota per the docs.
  const res = await mpdbFetch<{ response: unknown }>(['search', 'movies', 'test'], {
    language: 'fr_fr',
    _format: 'json',
  });
  if (res === null) {
    return { ok: false, message: 'Échec de la requête (vérifiez vos credentials)' };
  }
  return { ok: true, message: 'Credentials valides' };
}

// ── Helpers ────────────────────────────────────────────────────────────────

function extractMovie(res: unknown): MpdbMovie | null {
  if (!res || typeof res !== 'object') return null;
  // MPDB wraps single-movie responses in { response: {...} }
  const obj = res as { response?: MpdbMovie };
  if (obj.response && typeof obj.response === 'object' && !Array.isArray(obj.response)) {
    return obj.response;
  }
  // Or returns the movie directly
  if ('id' in (obj as MpdbMovie)) {
    return obj as MpdbMovie;
  }
  return null;
}

function pickBestSearchResult(res: unknown, expected: { title: string; year?: number }): MpdbMovie | null {
  if (!res || typeof res !== 'object') return null;
  const obj = res as { response?: { item: MpdbMovie[] } | MpdbMovie[] };
  let items: MpdbMovie[] = [];
  if (Array.isArray(obj.response)) {
    items = obj.response;
  } else if (obj.response?.item && Array.isArray(obj.response.item)) {
    items = obj.response.item;
  }
  if (items.length === 0) return null;

  // Pick the most coherent result — same logic as the cache coherence check.
  for (const item of items) {
    if (isCoherent(expected, { title: item.title, original_title: item.original_title, year: item.year })) {
      return item;
    }
  }
  // If none pass strict coherence, return the first result — the caller's
  // coherence check will reject it if it's wrong.
  return items[0];
}
