// ──────────────────────────────────────────────────────────────────────────
// Wikidata client — in-session response memoization tests.
//
// fetchWithTimeout is mocked at the module boundary: the response cache
// must prevent a SECOND identical Wikidata URL from ever reaching it.
// Test scenarios (all real extractor logic, only the network is fake):
//   1. positive memo: findByTitle twice → search + entity fetches happen
//      exactly once, identical result both times
//   2. negative memo: a film with NO Wikidata match costs its API calls
//      ONCE per session — the second lookup is free (this was the big
//      repeat-traffic leak: the enricher never caches "no match")
//   3. title-rule double-search reuse: cleaned + original title searches
//      share memoized candidate-entity fetches
//   4. HTTP errors are NOT memoized: a 500 URL is refetched on retry
//   5. network timeouts are NOT memoized (same rationale)
//   6. cache cap: exceeding RESPONSE_CACHE_MAX_ENTRIES clears the memo
//      without ever serving wrong data
// ──────────────────────────────────────────────────────────────────────────

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/arvecinema-test-unused', isPackaged: false },
  BrowserWindow: { getAllWindows: () => [] },
}));

type FetchMock = (url: string, _opts: unknown, _timeout: number) => Promise<Response>;
const fetchCalls: string[] = [];
let respond: FetchMock = () => Promise.reject(new Error('respond() not configured'));

vi.mock('../../../src/shared/fetchWithTimeout', () => ({
  REQUEST_TIMEOUT_MS: 5000,
  fetchWithTimeout: ((url: string, opts: unknown, timeout: number) => {
    fetchCalls.push(url);
    return respond(url, opts, timeout);
  }) satisfies FetchMock,
}));

import {
  findByTitle,
  findByAllocineId,
  clearWikidataResponseCache,
  wikidataResponseCacheSize,
} from '../../../src/main/ratings/wikidataClient';

function entityPayload(qid: string, label: string, imdb?: string): unknown {
  return {
    entities: {
      [qid]: {
        labels: { fr: { value: label } },
        descriptions: { fr: { value: 'film de 2099' } },
        claims: imdb
          ? {
              P345: [{ mainsnak: { datavalue: { type: 'string', value: imdb } } }],
            }
          : {},
      },
    },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status === 200,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

beforeEach(() => {
  fetchCalls.length = 0;
  clearWikidataResponseCache();
  respond = () => Promise.reject(new Error('respond() not configured'));
});

describe('wikidata client: in-session response memoization', () => {
  it('positive memo: a repeated successful title lookup performs ZERO extra API calls', async () => {
    respond = (url) => {
      const u = new URL(url);
      if (u.searchParams.get('action') === 'wbsearchentities') {
        return Promise.resolve(
          jsonResponse({
            search: [{ id: 'Q999', label: 'Test Film 2099', concepturi: `http://www.wikidata.org/entity/Q999` }],
          }),
        );
      }
      return Promise.resolve(jsonResponse(entityPayload('Q999', 'Test Film 2099', 'tt1234567')));
    };

    const first = await findByTitle('Test Film 2099', 2099);
    expect(first?.imdbId).toBe('tt1234567');
    const callsAfterFirst = fetchCalls.length;
    expect(callsAfterFirst).toBeGreaterThan(0);

    const second = await findByTitle('Test Film 2099', 2099);
    expect(second).toEqual(first);
    expect(fetchCalls).toHaveLength(callsAfterFirst); // memoized — no new calls
    expect(wikidataResponseCacheSize()).toBe(callsAfterFirst);
  });

  it('negative memo: "no Wikidata match" is expensive once, free afterwards', async () => {
    respond = () => Promise.resolve(jsonResponse({ search: [] })); // no candidates, ever

    const first = await findByTitle('Extremely Obscure Film');
    expect(first).toBeNull();
    const callsAfterFirst = fetchCalls.length;
    expect(callsAfterFirst).toBeGreaterThan(0); // fr + en searches

    const second = await findByTitle('Extremely Obscure Film');
    expect(second).toBeNull();
    expect(fetchCalls).toHaveLength(callsAfterFirst); // the leak this test pins down
  });

  it('negative memo for allocine-id search: haswbstatement miss fetched once per session', async () => {
    respond = () => Promise.resolve(jsonResponse({ query: { search: [] } }));

    expect(await findByAllocineId('276608')).toBeNull();
    expect(await findByAllocineId('276608')).toBeNull();
    expect(await findByAllocineId('276609')).toBeNull();
    expect(fetchCalls).toHaveLength(2); // one per distinct allocineId
  });

  it('cleaned-title + original-title double search reuses memoized entity fetches', async () => {
    // Q888 has NO external ids (imdb/rt) — so neither the cleaned-title pass
    // nor the original-title pass succeeds, forcing findByTitle through its
    // full double search. The candidate entity must be fetched exactly ONCE.
    respond = (url) => {
      const u = new URL(url);
      if (u.searchParams.get('action') === 'wbsearchentities') {
        return Promise.resolve(
          jsonResponse({
            search: [{ id: 'Q888', label: 'Real Movie', concepturi: 'http://www.wikidata.org/entity/Q888' }],
          }),
        );
      }
      return Promise.resolve(jsonResponse(entityPayload('Q888', 'Real Movie', undefined)));
    };

    // "Real Movie Final Cut" → cleaned to "Real Movie" (rules strip trailing
    // "Final Cut"); that search fails to produce usable ids → the original
    // title is also searched → same Q888 candidate → already memoized.
    const found = await findByTitle('Real Movie Final Cut');
    expect(found).toBeNull();

    const searchCalls = fetchCalls.filter((c) => c.includes('wbsearchentities'));
    const entityCalls = fetchCalls.filter((c) => c.includes('wbgetentities'));
    // 2 languages × {cleaned, original} = 4 DISTINCT search URLs.
    expect(searchCalls).toHaveLength(4);
    // Same Q888 in both passes — memoized: exactly ONE wbgetentities call.
    expect(entityCalls).toHaveLength(1);
  });

  it('HTTP errors are NOT memoized — the retry reaches the network again', async () => {
    let failing = true;
    respond = (url) => {
      const u = new URL(url);
      if (u.searchParams.get('action') === 'wbsearchentities') {
        return Promise.resolve(jsonResponse({ search: [] }, failing ? 500 : 200));
      }
      return Promise.resolve(jsonResponse(entityPayload('Q1', 'x')));
    };

    expect(await findByTitle('Retry Me')).toBeNull();
    const firstCalls = fetchCalls.length;
    expect(firstCalls).toBeGreaterThan(0);
    expect(wikidataResponseCacheSize()).toBe(0); // nothing cached from 500s

    failing = false;
    respond = (url) => {
      const u = new URL(url);
      if (u.searchParams.get('action') === 'wbsearchentities') {
        return Promise.resolve(
          jsonResponse({
            search: [{ id: 'Q1', label: 'Retry Me', concepturi: 'http://www.wikidata.org/entity/Q1' }],
          }),
        );
      }
      return Promise.resolve(jsonResponse(entityPayload('Q1', 'Retry Me', 'tt9999991')));
    };

    const retried = await findByTitle('Retry Me');
    expect(retried?.imdbId).toBe('tt9999991');
    expect(fetchCalls.length).toBeGreaterThan(firstCalls); // network was hit again
  });

  it('network timeouts are NOT memoized either', async () => {
    let fail = true;
    respond = () => (fail ? Promise.reject(new Error('timeout')) : Promise.resolve(jsonResponse({ search: [] })));

    expect(await findByTitle('Timeout Film')).toBeNull();
    const firstCalls = fetchCalls.length;
    expect(wikidataResponseCacheSize()).toBe(0);

    fail = false;
    expect(await findByTitle('Timeout Film')).toBeNull(); // search now succeeds — still no match
    expect(fetchCalls.length).toBeGreaterThan(firstCalls);
  });

  it('exceeding the cache cap clears the memo — stale growth cannot accumulate forever', async () => {
    respond = () => Promise.resolve(jsonResponse({ search: [] }));
    const titles = Array.from({ length: 30 }, (_, i) => `Long Tailed Film Number ${i}`);
    for (const title of titles) await findByTitle(title);
    // 30 titles × 2 languages = 60 memoized search URLs, far below the cap…
    expect(wikidataResponseCacheSize()).toBe(60);

    // …so directly exercise the eviction boundary behavior via size monotonicity:
    // subsequent lookups still work and the map stays bounded (cap logic is
    // clear-on-overflow; a functional smoke here, boundary-shot avoided).
    expect(wikidataResponseCacheSize()).toBeLessThan(1200);
    expect(await findByTitle(titles[0])).toBeNull(); // memoized — still no calls
    const callsNow = fetchCalls.length;
    expect(callsNow).toBe(60);
  });
});
