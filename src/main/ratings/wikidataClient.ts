import { fetchWithTimeout, REQUEST_TIMEOUT_MS } from '../../shared/fetchWithTimeout';
import { APP_USER_AGENT } from '../../shared/userAgent';
import { withNetworkTracking } from './networkActivity';

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
//   1. By Allociné ID (if the boxofficeapi `altId` field contains one) — most
//      reliable. We use the wbgetentities API with a SPARQL query.
//   2. By title + year (fallback). We use the wbsearchentities API to find
//      candidate QIDs, then verify each one is an instance of film (P31 Q11424).
//
// Both queries are cached persistently (no TTL) by the ratings enricher.
// ──────────────────────────────────────────────────────────────────────────

const WIKIDATA_API = 'https://www.wikidata.org/w/api.php';
const WIKIDATA_SPARQL = 'https://query.wikidata.org/sparql';
const WIKIDATA_UA = APP_USER_AGENT;

/** External IDs we extract from Wikidata for a film. */
export interface WikidataIds {
  qid: string;          // e.g. "Q113244935"
  imdbId?: string;      // e.g. "tt22084616"
  tmdbId?: string;      // e.g. "969681"
  rtPath?: string;      // e.g. "m/spider_man_brand_new_day"
  allocineId?: string;
  title: string;        // Wikidata label (for coherence check)
  description?: string;
  wikidataUrl: string;  // https://www.wikidata.org/wiki/Q113244935
}

// ── Headers ────────────────────────────────────────────────────────────────

const HEADERS: Record<string, string> = {
  'User-Agent': WIKIDATA_UA,
  Accept: 'application/json',
};

const SPARQL_HEADERS: Record<string, string> = {
  'User-Agent': WIKIDATA_UA,
  Accept: 'application/sparql-results+json',
};

// ── Lookup by Allociné ID (most reliable) ──────────────────────────────────

/**
 * Find a film in Wikidata by its AlloCiné ID.
 * Uses SPARQL to query the P1265 property directly.
 * If multiple results are returned, picks the best by year coherence.
 */
export async function findByAllocineId(
  allocineId: string,
  expectedYear?: number,
): Promise<WikidataIds | null> {
  const query = `SELECT ?item ?itemLabel ?itemDescription ?imdbId ?tmdbId ?rtPath ?releaseDate WHERE {
    ?item wdt:P1265 "${allocineId}".
    ?item wdt:P31/wdt:P279* wd:Q11424.
    OPTIONAL { ?item wdt:P345 ?imdbId. }
    OPTIONAL { ?item wdt:P4947 ?tmdbId. }
    OPTIONAL { ?item wdt:P1258 ?rtPath. }
    OPTIONAL { ?item wdt:P577 ?releaseDate. }
    SERVICE wikibase:label { bd:serviceParam wikibase:language "fr,en". }
  } LIMIT 5`;

  try {
    const url = new URL(WIKIDATA_SPARQL);
    url.searchParams.set('query', query);
    url.searchParams.set('format', 'json');
    const res = await withNetworkTracking(() => fetchWithTimeout(url.toString(), {
      headers: SPARQL_HEADERS,
    }, REQUEST_TIMEOUT_MS));
    if (!res.ok) return null;
    const data = await res.json() as SparqlResult;
    const bindings = data.results?.bindings ?? [];
    if (bindings.length === 0) return null;

    // If we have an expected year, pick the binding whose releaseDate matches.
    // This prevents matching "L'Inconnue" (2026) to the 2007 film.
    let best = bindings[0];
    if (expectedYear !== undefined && bindings.length > 1) {
      for (const b of bindings) {
        if (b.releaseDate?.value) {
          const bindingYear = new Date(b.releaseDate.value).getUTCFullYear();
          if (Math.abs(bindingYear - expectedYear) <= 1) {
            best = b;
            break;
          }
        }
      }
    }

    const r = best;
    const qid = r.item.value.split('/').pop()!;
    return {
      qid,
      imdbId: r.imdbId?.value,
      tmdbId: r.tmdbId?.value,
      rtPath: r.rtPath?.value,
      allocineId,
      title: r.itemLabel?.value ?? '',
      description: r.itemDescription?.value,
      wikidataUrl: `https://www.wikidata.org/wiki/${qid}`,
    };
  } catch (err) {
    console.warn('[wikidata] SPARQL lookup failed:', err);
    return null;
  }
}

// ── Lookup by title (fallback) ──────────────────────────────────────────────

interface WbSearchResult {
  id: string;           // Q-number
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
    const res = await withNetworkTracking(() => fetchWithTimeout(url.toString(), {
      headers: HEADERS,
    }, REQUEST_TIMEOUT_MS));
    if (!res.ok) return [];
    const data = await res.json() as { search?: WbSearchResult[] };
    return data.search ?? [];
  } catch {
    return [];
  }
}

/** Verify that a QID is actually a film (instance of Q11424) and get its
 *  external IDs. Returns null if not a film or no IDs found. */
async function getFilmIds(qid: string): Promise<WikidataIds | null> {
  const url = new URL(WIKIDATA_API);
  url.searchParams.set('action', 'wbgetentities');
  url.searchParams.set('ids', qid);
  url.searchParams.set('format', 'json');
  url.searchParams.set('props', 'claims|labels|descriptions');
  url.searchParams.set('languages', 'fr|en');

  try {
    const res = await withNetworkTracking(() => fetchWithTimeout(url.toString(), {
      headers: HEADERS,
    }, REQUEST_TIMEOUT_MS));
    if (!res.ok) return null;
    const data = await res.json() as WbGetEntitiesResult;
    const entity = data.entities?.[qid];
    if (!entity) return null;

    // Verify this is a film or film subclass. Wikidata classifies animated
    // films as Q202866 (animated film), not Q11424 (film) directly. So we
    // accept any of the common film types. If the entity has at least one
    // of the properties we care about (P345 IMDB, P1258 RT, P1262 AlloCiné),
    // we accept it even without a matching P31 — those properties are only
    // set on films.
    const FILM_TYPES = new Set([
      'Q11424',    // film
      'Q202866',   // animated film
      'Q24862',    // short film
      'Q506240',   // TV movie
      'Q20667498', // animated short film
    ]);
    const instanceOf = entity.claims?.P31 ?? [];
    const isFilmType = instanceOf.some(stmt => {
      const v = stmt.mainsnak?.datavalue?.value;
      return typeof v === 'object' && v !== null && FILM_TYPES.has(v['id'] as string);
    });
    const hasRelevantProp = Boolean(
      entity.claims?.P345 || entity.claims?.P1258 || entity.claims?.P1265
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
  } catch {
    return null;
  }
}

/** Find a film by title + year. Searches Wikidata for candidates, filters
 *  to films only, and picks the best match by coherence check. */
export async function findByTitle(
  title: string,
  year?: number,
): Promise<WikidataIds | null> {
  // Normalize the title: strip common French cinema prefixes/suffixes
  // that aren't part of the actual film title.
  const cleanTitle = title
    .replace(/^En\s+avant-première\s+/i, '')
    .replace(/\s+Extended\s*$/i, '')
    .replace(/\s+Final\s+Cut\s*$/i, '')
    .replace(/\s+Version\s+Longue\s*$/i, '')
    .replace(/\s+Director'?s?\s+Cut\s*$/i, '')
    .replace(/^Avant-première\s*:\s*/i, '')
    .replace(/^Avant-première\s+/i, '')
    .trim();

  // Try French first (the cinemas are French), then English.
  for (const lang of ['fr', 'en']) {
    const candidates = await searchEntities(cleanTitle, lang);
    if (candidates.length === 0) continue;

    // Take the top 5 candidates, fetch their full film IDs in parallel.
    const top = candidates.slice(0, 5);
    const checked = await Promise.all(top.map(c => getFilmIds(c.id)));
    const films = checked.filter((x): x is WikidataIds => x !== null);
    if (films.length === 0) continue;

    // Pick the best by coherence:
    //   - Title must match (fuzzy, accent-insensitive)
    //   - If we have a year, prefer films whose description mentions that year
    //   - Prefer films with an RT path (we can actually fetch ratings from RT)
    for (const f of films) {
      if (isCoherentTitle(title, f.title) && (year === undefined || descriptionMentionsYear(f.description, year))) {
        if (f.rtPath || f.imdbId) {
          return f;
        }
      }
    }
    // If no perfect match, return the first film that has an RT path.
    const withRt = films.find(f => f.rtPath);
    if (withRt) return withRt;
    // Or the first film with an IMDB ID.
    const withImdb = films.find(f => f.imdbId);
    if (withImdb) return withImdb;
  }
  return null;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function normalizeTitle(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    // Strip subtitle markers that don't change the film's identity
    // (e.g. " - partie 1 : L'Âge de Fer", "Final Cut", "Extended").
    .replace(/\s*[-:]\s*partie\s+\d+\s*[:\-]?\s*/g, ' ')
    .replace(/\s*[-:]\s*part\s+\d+\s*[:\-]?\s*/g, ' ')
    .replace(/\s+final\s*cut\s*$/i, '')
    .replace(/\s+extended\s*$/i, '')
    .replace(/\s+version\s+longue\s*$/i, '')
    .replace(/\s*[:\-]\s*/g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

function isCoherentTitle(expected: string, got: string): boolean {
  const a = normalizeTitle(expected);
  const b = normalizeTitle(got);
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.startsWith(b) || b.startsWith(a)) return true;
  // Token-subset match (same logic as in ratingsEnricher.ts) — accept when
  // all tokens of the shorter title appear in the longer one. Catches the
  // case where one source includes a subtitle the other omits.
  const aTokens = a.split(' ').filter(t => t.length > 2);
  const bTokens = b.split(' ').filter(t => t.length > 2);
  const [shorter, longer] = aTokens.length <= bTokens.length ? [aTokens, bTokens] : [bTokens, aTokens];
  if (shorter.length >= 3) {
    const longerSet = new Set(longer);
    if (shorter.every(t => longerSet.has(t))) return true;
  }
  return levenshtein(a, b) <= Math.max(3, Math.floor(Math.max(a.length, b.length) * 0.25));
}

function descriptionMentionsYear(description: string | undefined, year: number): boolean {
  if (!description) return true;   // don't penalize if no description
  // French films often say "film ... sorti en 2026" or "2026 film"
  return description.includes(String(year));
}

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

/** Convenience entry point — tries Allociné ID first, then title.
 *  Passes the year to both lookups so year-based disambiguation works. */
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
// Instead of firing one SPARQL query per film (which triggers Wikidata's
// rate limiting — HTTP 429), we batch up to 50 AlloCiné IDs into a single
// SPARQL query using the VALUES clause. This reduces 20+ queries to 1.
//
// The enricher calls this function for all unresolved films that have
// AlloCiné IDs, then falls back to per-film title search for the remaining
// films that don't have an AlloCiné ID.

/** Batch lookup: given a map of allocineId → expectedYear, return a map of
 *  allocineId → WikidataIds for all matches found. */
export async function findByAllocineIdsBatch(
  entries: Array<{ allocineId: string; expectedYear?: number }>,
): Promise<Map<string, WikidataIds>> {
  const result = new Map<string, WikidataIds>();
  if (entries.length === 0) return result;

  // Split into batches of 50 (Wikidata SPARQL has a practical limit on
  // VALUES clause size).
  const BATCH_SIZE = 50;

  for (let i = 0; i < entries.length; i += BATCH_SIZE) {
    const batch = entries.slice(i, i + BATCH_SIZE);
    const valuesClause = batch
      .map(e => `"${e.allocineId}"`)
      .join(' ');

    const query = `SELECT ?item ?itemLabel ?itemDescription ?imdbId ?tmdbId ?rtPath ?releaseDate ?allocineId WHERE {
      VALUES ?allocineId { ${valuesClause} }
      ?item wdt:P1265 ?allocineId.
      ?item wdt:P31/wdt:P279* wd:Q11424.
      OPTIONAL { ?item wdt:P345 ?imdbId. }
      OPTIONAL { ?item wdt:P4947 ?tmdbId. }
      OPTIONAL { ?item wdt:P1258 ?rtPath. }
      OPTIONAL { ?item wdt:P577 ?releaseDate. }
      SERVICE wikibase:label { bd:serviceParam wikibase:language "fr,en". }
    } LIMIT 250`;

    try {
      const url = new URL(WIKIDATA_SPARQL);
      url.searchParams.set('query', query);
      url.searchParams.set('format', 'json');
      const res = await withNetworkTracking(() => fetchWithTimeout(url.toString(), {
        headers: SPARQL_HEADERS,
      }, REQUEST_TIMEOUT_MS * 2));   // 2x timeout for batch queries

      if (!res.ok) {
        console.warn(`[wikidata] batch SPARQL returned HTTP ${res.status} for ${batch.length} IDs`);
        continue;   // Don't fail the whole batch — fall back to per-film lookup
      }

      const data = await res.json() as SparqlBatchResult;
      const bindings = data.results?.bindings ?? [];

      // Group bindings by allocineId
      const byAllocine = new Map<string, SparqlBinding[]>();
      for (const b of bindings) {
        const acId = b.allocineId?.value;
        if (!acId) continue;
        if (!byAllocine.has(acId)) byAllocine.set(acId, []);
        byAllocine.get(acId)!.push(b);
      }

      // For each requested allocineId, pick the best binding (by year if available)
      for (const entry of batch) {
        const candidates = byAllocine.get(entry.allocineId);
        if (!candidates || candidates.length === 0) continue;

        let best = candidates[0];
        if (entry.expectedYear !== undefined && candidates.length > 1) {
          for (const b of candidates) {
            if (b.releaseDate?.value) {
              const bindingYear = new Date(b.releaseDate.value).getUTCFullYear();
              if (Math.abs(bindingYear - entry.expectedYear) <= 1) {
                best = b;
                break;
              }
            }
          }
        }

        const r = best;
        const qid = r.item.value.split('/').pop()!;
        result.set(entry.allocineId, {
          qid,
          imdbId: r.imdbId?.value,
          tmdbId: r.tmdbId?.value,
          rtPath: r.rtPath?.value,
          allocineId: entry.allocineId,
          title: r.itemLabel?.value ?? '',
          description: r.itemDescription?.value,
          wikidataUrl: `https://www.wikidata.org/wiki/${qid}`,
        });
      }

      if (process.env.ARVE_DEBUG === '1') {
        console.log(`[wikidata] batch SPARQL: found ${result.size}/${entries.length} IDs in this batch`);
      }
    } catch (err) {
      console.warn(`[wikidata] batch SPARQL failed:`, err);
      // Fall through — films in this batch will be retried individually
      // by the enricher's per-film title search fallback.
    }

    // Brief delay between batches to be respectful to Wikidata's servers.
    if (i + BATCH_SIZE < entries.length) {
      await new Promise(r => setTimeout(r, 500));
    }
  }

  return result;
}

// ── Wikidata API response types ─────────────────────────────────────────────

interface SparqlResult {
  results?: {
    bindings: Array<{
      item: { value: string };
      itemLabel?: { value: string };
      itemDescription?: { value: string };
      imdbId?: { value: string };
      tmdbId?: { value: string };
      rtPath?: { value: string };
      releaseDate?: { value: string };
    }>;
  };
}

interface SparqlBinding {
  item: { value: string };
  itemLabel?: { value: string };
  itemDescription?: { value: string };
  imdbId?: { value: string };
  tmdbId?: { value: string };
  rtPath?: { value: string };
  releaseDate?: { value: string };
  allocineId?: { value: string };
}

interface SparqlBatchResult {
  results?: {
    bindings: SparqlBinding[];
  };
}

interface WbGetEntitiesResult {
  entities?: Record<string, {
    labels?: Record<string, { value: string }>;
    descriptions?: Record<string, { value: string }>;
    claims?: Record<string, Array<{
      mainsnak?: {
        datavalue?: {
          type: string;
          value?: string | { id?: string };
        };
      };
    }>>;
  }>;
}
