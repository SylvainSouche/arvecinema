// ──────────────────────────────────────────────────────────────────────────
// AlloCiné code resolution by title via Wikidata P1265.
//
// 2026-10: AlloCiné retired its server-rendered search (/recherche/?q= →
// 410 Gone; the /rechercher/ replacement is a JS shell behind their JWT'd
// GraphQL API). Wikidata maintains P1265 (AlloCiné film ID) per film, and
// builtin boxofficeapi cinemas already carry Allociné codes in their
// schedules — so this function is the title fallback for movies without a
// schedule-derived id (custom cinemas). Tests pin the resolution contract:
// coherent-label filtering, candidate batching, year hints, and caching.
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
    if (process.env.ARVE_DEBUG === '1') console.error('FETCH', url.slice(0, 150));
    return respond(url, opts, timeout);
  }) satisfies FetchMock,
}));

import {
  findAllocineIdByTitle,
  clearWikidataResponseCache,
} from '../../../src/main/ratings/wikidataClient';
import { searchAllocineByTitle } from '../../../src/main/ratings/allocineClient';

function searchPayload(...labels: Array<{ id: string; label: string }>): unknown {
  return { search: labels.map((l) => ({ id: l.id, label: l.label })) };
}

function entityPayload(
  qid: string,
  frLabel: string,
  opts: { allocineId?: string; description?: string } = {},
): unknown {
  const claims: Record<string, unknown[]> = {};
  if (opts.allocineId) {
    claims.P1265 = [{ mainsnak: { datavalue: { type: 'string', value: opts.allocineId } } }];
  }
  const entity: Record<string, unknown> = {
    labels: { fr: { value: frLabel } },
    claims,
  };
  if (opts.description) {
    entity.descriptions = { fr: { value: opts.description } };
  }
  return { entities: { [qid]: entity } };
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status === 200,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

let searchLabel: [string, string] = ['Q170564', 'Terminator 2 : Le Jugement dernier'];
let entity: Record<string, unknown> = {
  Q170564: { allocineId: '7124', description: 'film de 1991' },
};
/** URL-dispatching mock: search and entity-fetch are separate API actions. */
function dispatch(): (
  url: string,
  _opts: unknown,
  _timeout: number,
) => Promise<Response> {
  return (url: string) => {
    const u = new URL(url);
    if (u.searchParams.get('action') === 'wbsearchentities') {
      return Promise.resolve(jsonResponse(searchPayload({ id: searchLabel[0], label: searchLabel[1] })));
    }
    void entity;
    return Promise.resolve(jsonResponse(entityPayload(searchLabel[0], searchLabel[1], entity.Q170564 as never)));
  };
}

beforeEach(() => {
  fetchCalls.length = 0;
  clearWikidataResponseCache();
  respond = () => Promise.reject(new Error('respond() not configured'));
});

describe('findAllocineIdByTitle (Wikidata P1265 — the retired /recherche replacement)', () => {
  it('resolves a real programme title to its AlloCiné code (Terminator 2 → 7124)', async () => {
    respond = dispatch();
    const code = await findAllocineIdByTitle('Terminator 2 : le Jugement Dernier');
    expect(code).toBe('7124');
    // Protocol pin: only api.php actions, NO SPARQL, no allocine.fr search hit.
    for (const c of fetchCalls) {
      expect(c).toContain('https://www.wikidata.org/w/api.php');
    }
  });

  it('candidates without a P1265 claim yield null (no allocine code known)', async () => {
    respond = dispatch();
    entity = { Q170564: { description: 'film de 1991' } }; // no P1265 claim
    expect(await findAllocineIdByTitle('Terminator 2')).toBeNull();
  });

  it('incoherent label matches are rejected (guard against wrong-film wikidata hits)', async () => {
    respond = dispatch();
    searchLabel = ['Q999999', 'A completely different film'];
    expect(await findAllocineIdByTitle('Terminator 2 : le Jugement Dernier')).toBeNull();
  });

  it('a year hint must be consistent with the entity description', async () => {
    respond = dispatch();
    searchLabel = ['Q170564', 'Terminator 2 : Le Jugement dernier'];
    entity = { Q170564: { allocineId: '7124', description: 'film de 1991' } };
    expect(
      await findAllocineIdByTitle('Terminator 2 : le Jugement Dernier', 1991),
    ).toBe('7124');
    // 2019 has nothing to do with this film — the candidate must be rejected.
    expect(
      await findAllocineIdByTitle('Terminator 2 : le Jugement Dernier', 2019),
    ).toBeNull();
  });

  it('searchAllocineByTitle (allocine client) delegates and swallows network errors', async () => {
    respond = () => Promise.reject(new Error('network down'));
    expect(await searchAllocineByTitle('Terminator 2 : le Jugement Dernier')).toBeNull();
  });
});
