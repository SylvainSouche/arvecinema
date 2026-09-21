// ──────────────────────────────────────────────────────────────────────────
// ⚠️  SLEEPING BACKUP / DEV PROBE — NOT USED IN ACTIVE CODE  ⚠️
//
// This file implements IMDB GraphQL batched ratings via the
// `WatchlistStateById` persisted query against api.graphql.imdb.com.
//
// As of v0.5.0, this approach has been RETIRED in favor of `imdbDatasetClient.ts`,
// which uses IMDB's official public dataset (https://datasets.imdbws.com/
// title.ratings.tsv.gz) — a daily-refreshed SQLite-backed local cache.
//
// This file remains in the tree for two reasons:
//
//   1. **Sleeping backup** — if the dataset becomes unavailable in the
//      future, the GraphQL approach (now that we've solved the AWS WAF
//      challenge via `browserGraphqlFetch`) can be revived as a fallback.
//      Note however that the `WatchlistStateById` hash is anonymous-BLOCKED
//      (its query template includes `predefinedList`, which requires auth).
//      A different anonymous-safe batch hash would need to be discovered
//      before this could be re-enabled.
//
//   2. **Dev probe** — the `probeTop250()` function is still useful for
//      research. It demonstrates that `caching.graphql.imdb.com` accepts
//      anonymous GET requests with the right `Content-Type` + `x-imdb-*`
//      headers, and that the Top 250 chart operation is anonymous-safe.
//      Exposed via `window.electronAPI.probeTop250()` in dev mode only.
// ──────────────────────────────────────────────────────────────────────────

import { browserGraphqlFetch } from './browserFetch';
import { log } from './moduleLoggers';

// ──────────────────────────────────────────────────────────────────────────
// IMDB GraphQL batched ratings client.
//
// IMDB exposes a public GraphQL endpoint at https://api.graphql.imdb.com/
// that supports a persisted query (`WatchlistStateById`) returning aggregate
// ratings for a LIST of titles in a single HTTP call.
//
// Compared to scraping one HTML page per film:
//   - One request fetches up to 50 ratings → ~50× less traffic to IMDB
//   - JSON response (no HTML parsing, no Cloudflare challenge page)
//   - Lower burden on IMDB's servers → less likely to trigger WAF blocks
//   - The endpoint is the same one imdb.com uses for its watchlist UI
//
// The endpoint is anonymous (no cookies required): `userRating` and
// `userWatchedStatus` come back as `null`, but `aggregateRating` and
// `voteCount` are public data and returned normally.
//
// We use this as the primary IMDB ratings path, with a 3-strike fallback
// to the per-film `browserFetch` scraper in `imdbClient.ts`:
//   - If a batch fails (HTTP non-200, parse error, network), increment a
//     shared failure counter.
//   - After 3 failures, `isGraphqlDisabled()` returns true and the
//     enricher falls back to per-film scraping for the remainder of the
//     session.
//
// All requests go through `browserGraphqlFetch` (a hidden Electron
// BrowserWindow that loads an imdb.com page first to clear the AWS WAF
// challenge, then executes the GraphQL fetch from inside the page's
// context — inheriting the WAF cookie, origin, and TLS fingerprint).
// This is the only anonymous way to reach api.graphql.imdb.com — plain
// fetch() is rejected with HTTP 415 regardless of method or headers.
//
// **Method: GET with URL-encoded query parameters.** GET is what the
// imdb.com browser uses for persisted queries (we verified this via HAR
// capture). The browser's fetch from the page context handles cookies
// and headers automatically.
// ──────────────────────────────────────────────────────────────────────────

const IMDB_GRAPHQL_URL = 'https://api.graphql.imdb.com/';
const PERSISTED_QUERY_HASH = '8573d31b2dda37d8daa0ad258982b67d44f2c7aed823f423eb03fd543a20cada';
const PERSISTED_QUERY_VERSION = 1;

/** Max IDs per request — IMDB's GraphQL endpoint accepts up to 50. */
const BATCH_SIZE = 50;

/** Number of failures before we permanently switch to fallback scraper. */
const MAX_FAILURES = 3;

const DEBUG = process.env.ARVE_DEBUG === '1';

// ── Failure tracker (process-wide) ──────────────────────────────────────────

let graphqlFailures = 0;
// HARD-DISABLED: the only known batch persisted query hash for IMDB
// (`WatchlistStateById`, 8573d31b...) includes the `predefinedList` field
// in its server-side query template, which requires an authenticated user.
// Even with WAF cookies properly cleared (HTTP 200), the GraphQL response
// is `BAD_USER_INPUT: User param required for unauthenticated use of
// predefinedList`.
//
// Until we discover a different batch persisted hash that's anonymous-safe
// (likely by capturing HAR traffic from a title detail page like
// /title/tt0111161/ instead of the watchlist page), the GraphQL path is
// disabled and we rely on the per-film `browserFetch` HTML scraper for IMDB.
//
// To re-enable for experimentation, set ARVE_IMDB_GRAPHQL=1 in the env.
const GRAPHQL_HARD_DISABLED = process.env.ARVE_IMDB_GRAPHQL !== '1';
let graphqlDisabled = GRAPHQL_HARD_DISABLED;

/** Has the GraphQL path been disabled for this session? */
export function isGraphqlDisabled(): boolean {
  return graphqlDisabled;
}

/** Reset the failure counter (used by tests / manual retry). */
export function resetGraphqlFailureCounter(): void {
  graphqlFailures = 0;
  graphqlDisabled = GRAPHQL_HARD_DISABLED;
}

// ── Top 250 probe (anonymous-safe, GET, caching.graphql.imdb.com) ────────
//
// The user captured this persisted query hash from imdb.com's Top 250 chart
// page. It's a publicly visible chart, so the query is anonymous-safe (no
// `predefinedList` field, no auth required).
//
// We don't use it for our use case directly (our films are new releases,
// not Top 250 material), but it serves as a proof-of-concept that:
//   1. `caching.graphql.imdb.com` accepts anonymous GET requests
//   2. There exist anonymous-safe persisted query hashes
//   3. Our `browserGraphqlFetch` (GET mode) works against this endpoint
//
// If this probe succeeds, we know the infrastructure works — we just need
// to find a hash for our actual use case (batch title ratings).
//
// Call from dev console: `imdbGraphqlClient.probeTop250()`.
const CACHING_GRAPHQL_URL = 'https://caching.graphql.imdb.com/';
const TOP_250_HASH = '3fe684000f533f225ba87cf001ef821c0c7de23a2644f7a27acebb04d85d974f';

/**
 * Probe the Top 250 endpoint to verify that `caching.graphql.imdb.com`
 * works anonymously with our `browserGraphqlFetch` (GET mode).
 *
 * Returns the first 1000 bytes of the response, or throws on failure.
 *
 * Usage: call from the renderer's dev console via `window.electronAPI.probeTop250()`,
 * or invoke directly from main process code in dev.
 */
export async function probeTop250(): Promise<string> {
  const url = new URL(CACHING_GRAPHQL_URL);
  url.searchParams.set('operationName', 'Top250MoviesPagination');
  // First-page variables — omit the `after` cursor entirely. IMDB signs
  // cursors with a `sig` field for pagination; we can't fabricate one, but
  // we don't need to — the first page is returned without a cursor.
  const variables = {
    first: 5,
    locale: 'fr-FR',
  };
  url.searchParams.set('variables', JSON.stringify(variables));
  url.searchParams.set(
    'extensions',
    JSON.stringify({
      persistedQuery: {
        sha256Hash: TOP_250_HASH,
        version: 1,
      },
    }),
  );

  if (DEBUG) {
    log.imdbGraphql.debug(`probing Top250 via GET to caching.graphql.imdb.com`);
    log.imdbGraphql.debug(`  URL: ${url.toString()}`);
  }

  // GET mode — no requestBody, just URL params
  const responseBody = await browserGraphqlFetch(url.toString(), 'https://www.imdb.com/');

  if (DEBUG) {
    log.imdbGraphql.debug(`probe response (${responseBody.length} bytes):`);
    log.imdbGraphql.debug(responseBody.substring(0, 1000));
  }
  return responseBody;
}

function recordFailure(reason: string): void {
  graphqlFailures++;
  if (DEBUG) {
    log.imdbGraphql.warn(`failure ${graphqlFailures}/${MAX_FAILURES}: ${reason}`);
  }
  if (graphqlFailures >= MAX_FAILURES && !graphqlDisabled) {
    graphqlDisabled = true;
    log.imdbGraphql.warn(
      `disabled after ${graphqlFailures} failures — ` +
        `falling back to per-film browserFetch for the rest of this session.`,
    );
  }
}

// ── Types ────────────────────────────────────────────────────────────────────

export interface ImdbBatchEntry {
  imdbId: string;
  rating?: number;
  votes?: number;
  url: string;
  status: 'ok' | 'absent' | 'blocked';
  statusMessage?: string;
}

interface GraphqlTitle {
  id: string;
  titleText?: { text?: string };
  ratingsSummary?: {
    aggregateRating?: number | null;
    voteCount?: number | null;
  };
}

interface GraphqlResponse {
  data?: {
    titles?: GraphqlTitle[];
  };
  errors?: Array<{ message: string }>;
}

// ── Batch fetch ────────────────────────────────────────────────────────────

/**
 * Fetch ratings for a batch of IMDB IDs via the GraphQL persisted query.
 *
 * Returns a map keyed by `imdbId` (lowercased, with `tt` prefix preserved)
 * so the caller can correlate results back to its own queue.
 *
 * On any error (network, HTTP status, parse, GraphQL errors array), records
 * a failure via `recordFailure()` and returns an empty map — the caller is
 * responsible for falling back to per-film scraping for those IDs.
 */
export async function fetchImdbRatingsBatch(
  imdbIds: string[],
): Promise<Map<string, ImdbBatchEntry>> {
  const results = new Map<string, ImdbBatchEntry>();

  if (imdbIds.length === 0) return results;
  if (graphqlDisabled) return results;

  // Dedupe + sanitize: IMDB IDs are `tt` + 7-10 digits.
  const uniqueIds = [...new Set(imdbIds.filter(isValidImdbId))];
  if (uniqueIds.length === 0) return results;

  // Split into batches of BATCH_SIZE.
  // Batches are serialized by the connection pool's per-domain chain — no
  // need for an internal sleep here. The pool applies its 2-second domain
  // delay between consecutive batches to api.graphql.imdb.com.
  for (let i = 0; i < uniqueIds.length; i += BATCH_SIZE) {
    const batch = uniqueIds.slice(i, i + BATCH_SIZE);

    try {
      const batchResults = await fetchSingleBatch(batch);
      for (const [id, entry] of batchResults) {
        results.set(id, entry);
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      recordFailure(`batch [${batch.length}] failed: ${reason}`);
      // Don't mark individual films as failed — the caller's fallback path
      // will handle them via per-film browserFetch. Just return what we
      // have so far.
      return results;
    }
  }

  return results;
}

async function fetchSingleBatch(batch: string[]): Promise<Map<string, ImdbBatchEntry>> {
  const results = new Map<string, ImdbBatchEntry>();

  // Build the POST body. IMDB's GraphQL backend REQUIRES POST with
  // `Content-Type: application/json` (per the official API docs at
  // https://data.imdb.com/documentation/api-documentation/calling-the-api/).
  // GET requests are rejected with HTTP 415
  // "Invalid content type, must be application/json" — even with persisted
  // query hashes in the URL query params, even with proper cookies.
  //
  // The body must contain `operationName`, `variables`, and `extensions`
  // as JSON fields (Apollo Persisted Query standard). Critically, we use
  // the persisted query hash only — we do NOT include a raw `query` string,
  // which would trigger an auth block on `predefinedList`.
  const requestBody = {
    operationName: 'WatchlistStateById',
    variables: { ids: batch },
    extensions: {
      persistedQuery: {
        sha256Hash: PERSISTED_QUERY_HASH,
        version: PERSISTED_QUERY_VERSION,
      },
    },
  };

  if (DEBUG) {
    log.imdbGraphql.debug(`→ POST batch of ${batch.length} (first: ${batch[0]})`);
    log.imdbGraphql.debug(`  URL: ${IMDB_GRAPHQL_URL}`);
    log.imdbGraphql.debug(`  body: ${JSON.stringify(requestBody)}`);
  }

  const startTime = Date.now();
  // Use browserGraphqlFetch: load an imdb.com page first to clear the AWS
  // WAF challenge (which mints the aws-waf-token cookie via challenge.js),
  // then execute the GraphQL fetch from inside the page's own context —
  // inheriting all cookies, the same origin, and the browser's TLS
  // fingerprint. This is the ONLY anonymous way to reach the IMDB GraphQL
  // API; plain fetch() gets rejected with HTTP 415 regardless of method
  // or headers.
  //
  // The hidden window's session partition persists the WAF cookie, so
  // subsequent batches reuse it without re-solving the challenge.
  const responseBody = await browserGraphqlFetch(
    IMDB_GRAPHQL_URL, // bare URL — no query params, params go in body
    'https://www.imdb.com/', // any imdb.com page — we just need to clear WAF
    requestBody,
  );
  const elapsedMs = Date.now() - startTime;

  // Parse the JSON response. browserGraphqlFetch already validated the HTTP
  // status (throws on non-2xx), so we just need JSON.parse here.
  let data: GraphqlResponse;
  try {
    data = JSON.parse(responseBody) as GraphqlResponse;
  } catch (err) {
    throw new Error(`JSON parse failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // GraphQL endpoint can return 200 with an `errors` array.
  if (data.errors && data.errors.length > 0) {
    const msgs = data.errors.map((e) => e.message).join('; ');
    throw new Error(`GraphQL errors: ${msgs}`);
  }

  const titles = data.data?.titles ?? [];
  if (DEBUG) {
    log.imdbGraphql.debug(`← ${titles.length} results in ${elapsedMs}ms`);
  }

  // Build a fast lookup by ID (case-insensitive).
  const byId = new Map<string, GraphqlTitle>();
  for (const t of titles) {
    byId.set(t.id.toLowerCase(), t);
  }

  // For each requested ID, build the result entry. Missing IDs in the
  // response get status='absent' so the caller can fall back per-film.
  for (const imdbId of batch) {
    const url = `https://www.imdb.com/title/${imdbId}/`;
    const t = byId.get(imdbId.toLowerCase());

    if (!t) {
      results.set(imdbId, {
        imdbId,
        url,
        status: 'absent',
        statusMessage: 'ID not found in GraphQL response',
      });
      continue;
    }

    const rating = t.ratingsSummary?.aggregateRating ?? undefined;
    const votes = t.ratingsSummary?.voteCount ?? undefined;

    if (typeof rating === 'number' && Number.isFinite(rating) && rating >= 0 && rating <= 10) {
      results.set(imdbId, {
        imdbId,
        rating,
        votes: typeof votes === 'number' && Number.isFinite(votes) ? votes : undefined,
        url,
        status: 'ok',
      });
    } else {
      // Title exists but has no aggregate rating yet (e.g. unreleased film).
      results.set(imdbId, {
        imdbId,
        url,
        status: 'absent',
        statusMessage: t.titleText?.text
          ? `"${t.titleText.text}" has no aggregate rating`
          : 'No aggregate rating on this title',
      });
    }
  }

  return results;
}

/** Validate an IMDB ID format: `tt` followed by 7-10 digits. */
function isValidImdbId(id: string): boolean {
  return /^tt\d{7,10}$/.test(id);
}
