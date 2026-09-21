import { fetchWithTimeout, REQUEST_TIMEOUT_MS } from '../../shared/fetchWithTimeout';
import { APP_USER_AGENT } from '../../shared/userAgent';
import { withNetworkTracking } from './networkActivity';
import { log } from './moduleLoggers';
import { cleanTitle as applyTitleRules } from '../../shared/titleRules';

// ──────────────────────────────────────────────────────────────────────────
// Wikidata client — public, free, no API key required.
//
// Wikidata stores external identifiers for films:
//   P345  = IMDB ID (e.g. "tt22084616")
//   P4947 = TMDB ID (e.g. "969681")
//   P1258 = Rotten Tomatoes path (e.g. "m/spider_man_brand_new_day")
//   P1265 = Allociné film ID (e.g. "276608")
//
// Two lookup strategies:
//   1. By Allociné ID — uses the MediaWiki search API (`haswbstatement:`)
//      to find QIDs by property value, then `wbgetentities` to fetch the
//      external IDs. This is MUCH faster than SPARQL (<500ms vs 5-30s)
//      and doesn't suffer from SPARQL's 60-second timeouts.
//   2. By title + year (fallback). Uses `wbsearchentities` to find
//      candidate QIDs, then `wbgetentities` to verify + extract IDs.
//
// Both strategies are cached permanently (no TTL) by the ratings enricher.
//
// NOTE: We intentionally do NOT use the SPARQL endpoint (query.wikidata.org).
// It has a 60-second timeout, strict rate limiting (HTTP 429), and complex
// graph queries are frequently killed by the query optimizer. The MediaWiki
// Action API (www.wikidata.org/w/api.php) is faster, better rate-limited,
// and more reliable.
// ──────────────────────────────────────────────────────────────────────────

const WIKIDATA_API = 'https://www.wikidata.org/w/api.php';
const WIKIDATA_UA = APP_USER_AGENT;

/** External IDs we extract from Wikidata for a film. */
export interface WikidataIds {
  qid: string;
  imdbId?: string;
  tmdbId?: string;
  rtPath?: string;
  allocineId?: string;
  title: string;
  description?: string;
  wikidataUrl: string;
}

const HEADERS: Record<string, string> = {
  'User-Agent': WIKIDATA_UA,
  Accept: 'application/json',
};

// ── Lookup by Allociné ID (MediaWiki search API — no SPARQL) ──────────────

/**
 * Find the QID of a Wikidata entity that has the given Allociné ID (P1265).
 * Uses `haswbstatement:P1265=<value>` on the MediaWiki search API.
 * Returns the first matching QID, or null if not found.
 */
async function findQidByAllocineId(allocineId: string): Promise<string | null> {
  const url = new URL(WIKIDATA_API);
  url.searchParams.set('action', 'query');
  url.searchParams.set('list', 'search');
  url.searchParams.set('srsearch', `haswbstatement:P1265=${allocineId}`);
  url.searchParams.set('format', 'json');
  url.searchParams.set('srlimit', '5');
  url.searchParams.set('srnamespace', '0');

  try {
    const res = await withNetworkTracking(() =>
      fetchWithTimeout(url.toString(), { headers: HEADERS }, REQUEST_TIMEOUT_MS),
    );
    if (!res.ok) return null;
    const data = (await res.json()) as { query?: { search?: Array<{ title: string }> } };
    const hits = data.query?.search ?? [];
    if (hits.length === 0) return null;
    return hits[0].title;
  } catch {
    return null;
  }
}

/**
 * Find a film in Wikidata by its AlloCiné ID.
 * Two-step: (1) search for the QID by P1265 value, (2) fetch entity data.
 */
export async function findByAllocineId(
  allocineId: string,
  expectedYear?: number,
): Promise<WikidataIds | null> {
  const qid = await findQidByAllocineId(allocineId);
  if (!qid) return null;

  const ids = await getFilmIds(qid);
  if (!ids) return null;

  void expectedYear; // P1265 is authoritative — year check is not needed
  return { ...ids, allocineId };
}

// ── Lookup by title (fallback) ────────────────────────────────────────────

interface WbSearchResult {
  id: string;
  label: string;
  description?: string;
  concepturi: string;
}

/** Search Wikidata for entities matching a title. Returns candidates. */
async function searchEntities(title: string, language = 'fr'): Promise<WbSearchResult[]> {
  const url = new URL(WIKIDATA_API);
  url.searchParams.set('action', 'wbsearchentities');
  url.searchParams.set('search', title);
  url.searchParams.set('language', language);
  url.searchParams.set('format', 'json');
  url.searchParams.set('limit', '10');
  url.searchParams.set('type', 'item');

  try {
    const res = await withNetworkTracking(() =>
      fetchWithTimeout(url.toString(), { headers: HEADERS }, REQUEST_TIMEOUT_MS),
    );
    if (!res.ok) return [];
    const data = (await res.json()) as { search?: WbSearchResult[] };
    return data.search ?? [];
  } catch {
    return [];
  }
}

// ── Batch wbgetentities — fetch multiple entities at once ──────────────────

/**
 * Fetch entity data (claims + labels + descriptions) for multiple QIDs in
 * a single `wbgetentities` call. The API accepts up to 50 IDs per request.
 */
async function batchGetFilmIds(qids: string[]): Promise<Map<string, WikidataIds>> {
  const result = new Map<string, WikidataIds>();
  if (qids.length === 0) return result;

  // wbgetentities accepts up to 50 IDs per call
  const BATCH_SIZE = 50;
  for (let i = 0; i < qids.length; i += BATCH_SIZE) {
    const batch = qids.slice(i, i + BATCH_SIZE);
    const url = new URL(WIKIDATA_API);
    url.searchParams.set('action', 'wbgetentities');
    url.searchParams.set('ids', batch.join('|'));
    url.searchParams.set('format', 'json');
    url.searchParams.set('props', 'claims|labels|descriptions');
    url.searchParams.set('languages', 'fr|en');

    try {
      const res = await withNetworkTracking(() =>
        fetchWithTimeout(url.toString(), { headers: HEADERS }, REQUEST_TIMEOUT_MS),
      );
      if (!res.ok) {
        log.wikidata.warn(
          `[wikidata] wbgetentities returned HTTP ${res.status} for ${batch.length} IDs`,
        );
        continue;
      }
      const data = (await res.json()) as WbGetEntitiesResult;
      for (const qid of batch) {
        const ids = parseEntity(data.entities?.[qid], qid);
        if (ids) result.set(qid, ids);
      }
    } catch (err) {
      log.wikidata.warn(
        `[wikidata] wbgetentities failed: ` + (err instanceof Error ? err.message : String(err)),
      );
    }
  }
  return result;
}

/** Parse a wbgetentities response for a single entity → WikidataIds. */
function parseEntity(entity: WbEntity | undefined, qid: string): WikidataIds | null {
  if (!entity) return null;

  const FILM_TYPES = new Set([
    'Q11424', // film
    'Q202866', // animated film
    'Q24862', // short film
    'Q506240', // TV movie
    'Q20667498', // animated short film
  ]);
  const instanceOf = entity.claims?.P31 ?? [];
  const isFilmType = instanceOf.some((stmt) => {
    const v = stmt.mainsnak?.datavalue?.value;
    return typeof v === 'object' && v !== null && FILM_TYPES.has(v['id'] as string);
  });
  const hasRelevantProp = Boolean(
    entity.claims?.P345 || entity.claims?.P1258 || entity.claims?.P1265,
  );
  if (!isFilmType && !hasRelevantProp) return null;

  const getStrValue = (prop: string): string | undefined => {
    const stmts = entity.claims?.[prop];
    if (!stmts || stmts.length === 0) return undefined;
    const v = stmts[0].mainsnak?.datavalue?.value;
    return typeof v === 'string' ? v : undefined;
  };

  const title = entity.labels?.fr?.value ?? entity.labels?.en?.value ?? '';
  const description = entity.descriptions?.fr?.value ?? entity.descriptions?.en?.value;

  return {
    qid,
    imdbId: getStrValue('P345'),
    tmdbId: getStrValue('P4947'),
    rtPath: getStrValue('P1258'),
    allocineId: getStrValue('P1265'),
    title,
    description,
    wikidataUrl: `https://www.wikidata.org/wiki/${qid}`,
  };
}

/** Verify that a QID is actually a film and get its external IDs. */
async function getFilmIds(qid: string): Promise<WikidataIds | null> {
  const url = new URL(WIKIDATA_API);
  url.searchParams.set('action', 'wbgetentities');
  url.searchParams.set('ids', qid);
  url.searchParams.set('format', 'json');
  url.searchParams.set('props', 'claims|labels|descriptions');
  url.searchParams.set('languages', 'fr|en');

  try {
    const res = await withNetworkTracking(() =>
      fetchWithTimeout(url.toString(), { headers: HEADERS }, REQUEST_TIMEOUT_MS),
    );
    if (!res.ok) return null;
    const data = (await res.json()) as WbGetEntitiesResult;
    return parseEntity(data.entities?.[qid], qid);
  } catch {
    return null;
  }
}

/** Find a film by title + year.
 *
 *  Uses the systematic title-cleaning rules from `shared/titleRules/` to
 *  strip cinema-event prefixes/suffixes (avant-première, extended, director's
 *  cut, etc.) before searching Wikidata.
 *
 *  If the cleaned title yields no results, retries with the original title
 *  (some films genuinely have "Extended" or "Final Cut" in their title). */
export async function findByTitle(title: string, year?: number): Promise<WikidataIds | null> {
  // Apply systematic title-cleaning rules (French + English)
  const { cleaned: cleanedTitle, wasModified } = applyTitleRules(title);

  // Also normalize colons — "Avengers : Endgame" → "Avengers Endgame"
  // (Wikidata's wbsearchentities doesn't handle colons well)
  const searchTitle = cleanedTitle.replace(/\s*:\s*/g, ' ').trim();
  const originalSearchTitle = title.replace(/\s*:\s*/g, ' ').trim();

  // Try the cleaned title first
  const result = await searchWikidataByTitle(searchTitle, year);
  if (result) return result;

  // If we stripped something AND the cleaned search found nothing,
  // retry with the ORIGINAL title (uncleaned). This handles the case
  // where a film's actual title contains a word our rules strip
  // (e.g. "Final Cut" is a real film title).
  if (wasModified && searchTitle !== originalSearchTitle) {
    if (process.env.ARVE_DEBUG === '1') {
      log.wikidata.info(
        `[wikidata] retrying with original title "${originalSearchTitle}" ` +
          `(cleaned "${searchTitle}" found nothing)`,
      );
    }
    return searchWikidataByTitle(originalSearchTitle, year);
  }

  return null;
}

/** Internal: search Wikidata by a given title string + year. */
async function searchWikidataByTitle(title: string, year?: number): Promise<WikidataIds | null> {
  for (const lang of ['fr', 'en']) {
    const candidates = await searchEntities(title, lang);
    if (candidates.length === 0) continue;

    const top = candidates.slice(0, 5);
    const checked = await Promise.all(top.map((c) => getFilmIds(c.id)));
    const films = checked.filter((x): x is WikidataIds => x !== null);
    if (films.length === 0) continue;

    for (const f of films) {
      if (
        isCoherentTitle(title, f.title) &&
        (year === undefined || descriptionMentionsYear(f.description, year))
      ) {
        if (f.rtPath || f.imdbId) {
          return f;
        }
      }
    }
    const withRt = films.find((f) => f.rtPath);
    if (withRt) return withRt;
    const withImdb = films.find((f) => f.imdbId);
    if (withImdb) return withImdb;
  }
  return null;
}

// ── Helpers ──────────────────────────────────────────────────────────────

function normalizeTitle(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s*[-:]\s*partie\s+\d+\s*[:\-]?\s*/g, ' ')
    .replace(/\s*[-:]\s*part\s+\d+\s*[:\-]?\s*/g, ' ')
    .replace(/\s+final\s*cut\s*$/i, '')
    .replace(/\s+extended\s*$/i, '')
    .replace(/\s+version\s+longue\s*$/i, '')
    .replace(/\s*[:\-]\s*/g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isCoherentTitle(expected: string, got: string): boolean {
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

function descriptionMentionsYear(description: string | undefined, year: number): boolean {
  if (!description) return true;
  return description.includes(String(year));
}

function levenshtein(a: string, b: string): number {
  const m = a.length,
    n = b.length;
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

/** Convenience entry point — tries Allociné ID first, then title. */
export async function findMovieIds(movie: {
  title: string;
  year?: number;
  allocineId?: string;
}): Promise<WikidataIds | null> {
  if (movie.allocineId) {
    const byId = await findByAllocineId(movie.allocineId, movie.year);
    if (byId) return byId;
  }
  return findByTitle(movie.title, movie.year);
}

// ── Batch lookup by multiple AlloCiné IDs ──────────────────────────────────
//
// Instead of SPARQL, we use the MediaWiki search API (`haswbstatement:`)
// to find QIDs by property value. This is much faster and more reliable:
//
//   1. Fire parallel search queries (5 at a time) for each Allociné ID
//      → returns QIDs
//   2. Batch-fetch all found QIDs via `wbgetentities` (up to 50 per call)
//      → returns IMDB/RT/TMDB IDs
//
// Total time for 20 films: ~2s (was 5-30s with SPARQL, often timing out).
// Total API calls: 20 searches + 1 wbgetentities = 21 (was 1 SPARQL query
// that timed out 50% of the time).

/** Batch lookup: given allocineId → expectedYear entries, return allocineId → WikidataIds. */
export async function findByAllocineIdsBatch(
  entries: Array<{ allocineId: string; expectedYear?: number }>,
): Promise<Map<string, WikidataIds>> {
  const result = new Map<string, WikidataIds>();
  if (entries.length === 0) return result;

  // Phase 1: Find QIDs for all Allociné IDs — SEQUENTIAL (not parallel)
  // Wikimedia rate-limits parallel requests from the same IP with 429 errors.
  // A 100ms delay between requests keeps us under the limit and is still
  // fast: 20 films × 100ms = 2s total, vs 5-30s with SPARQL.
  const allocineToQid = new Map<string, string>();

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const qid = await findQidByAllocineId(entry.allocineId);
    if (qid) allocineToQid.set(entry.allocineId, qid);

    // Small delay between requests to respect Wikimedia's rate limits.
    // 200ms is the minimum that avoids 429 errors in testing.
    if (i + 1 < entries.length) {
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  if (allocineToQid.size === 0) {
    log.wikidata.info(`[wikidata] batch search: found 0/${entries.length} QIDs via haswbstatement`);
    return result;
  }

  // Phase 2: Batch-fetch entity data for all found QIDs
  const allQids = [...allocineToQid.values()];
  const entitiesMap = await batchGetFilmIds(allQids);

  // Phase 3: Map results back to Allociné IDs
  for (const [allocineId, qid] of allocineToQid) {
    const ids = entitiesMap.get(qid);
    if (ids) {
      result.set(allocineId, { ...ids, allocineId });
    }
  }

  log.wikidata.info(
    `[wikidata] batch search: found ${result.size}/${entries.length} IDs ` +
      `(${allocineToQid.size} QIDs found, ${entitiesMap.size} entities parsed)`,
  );

  return result;
}

// ── Wikidata API response types ───────────────────────────────────────────

interface WbEntity {
  labels?: Record<string, { value: string }>;
  descriptions?: Record<string, { value: string }>;
  claims?: Record<
    string,
    Array<{
      mainsnak?: {
        datavalue?: {
          type: string;
          value?: string | { id?: string };
        };
      };
    }>
  >;
}

interface WbGetEntitiesResult {
  entities?: Record<string, WbEntity>;
}
