// ──────────────────────────────────────────────────────────────────────────
// COVERAGE: Layer 1 — Unit tests for SQLite cache operations.
//
// Tests: initCacheDb, getMeta/setMeta, ids_cache CRUD, ratings_cache CRUD
//        (including COALESCE UPSERT regression), imdb_ratings bulk insert.
//
// Catches: Cache corruption, data loss on partial updates, UPSERT regressions
//          (INSERT OR REPLACE would NULL out unspecified columns), schema
//          migration issues (via version checks).
//
// Misses: Whether the schema matches what the app expects in production
//        (only tests the functions in isolation). Does NOT test migration
//        paths from older schema versions — that's a planned Layer 3 test.
//
// See TESTING.md for the full failure-mode → test-layer matrix.
// ──────────────────────────────────────────────────────────────────────────
// Unit tests for src/main/ratings/cacheDb.ts — SQLite cache operations.
// Mocks electron.app.getPath('userData') to a temp directory we control.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const TMP_DIR = path.join(os.tmpdir(), `arvecinema-test-${process.pid}`);
const USER_DATA_DIR = path.join(TMP_DIR, 'userData');

fs.mkdirSync(USER_DATA_DIR, { recursive: true });

vi.mock('electron', () => ({
  app: {
    getPath: () => USER_DATA_DIR,
  },
}));

vi.mock('../../../src/main/ratings/moduleLoggers', () => ({
  log: {
    cacheDb: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
  },
}));

import {
  initCacheDb,
  closeCacheDb,
  getMeta,
  setMeta,
  getIdsCacheEntry,
  getIdsCacheEntryByQid,
  getIdsCacheEntryByTitleKey,
  getIdsCacheEntriesByTitlePrefix,
  upsertIdsCacheEntry,
  getRatingsCacheEntry,
  upsertRatingsCacheEntry,
  getImdbRating,
  getImdbRatingsBatch,
  getImdbRatingCount,
  clearAndBulkInsertImdbRatings,
  getSchemaVersion,
  isCacheDbAvailable,
} from '../../../src/main/ratings/cacheDb';

beforeEach(() => {
  fs.mkdirSync(USER_DATA_DIR, { recursive: true });
  initCacheDb();
});

afterEach(() => {
  closeCacheDb();
  for (const file of fs.readdirSync(USER_DATA_DIR)) {
    if (file.startsWith('cache.db')) {
      fs.unlinkSync(path.join(USER_DATA_DIR, file));
    }
  }
});

describe('initCacheDb', () => {
  it('opens the DB and creates all v1 tables', () => {
    expect(isCacheDbAvailable()).toBe(true);
    expect(getSchemaVersion()).toBe(1);
  });

  it('is idempotent', () => {
    initCacheDb();
    initCacheDb();
    expect(isCacheDbAvailable()).toBe(true);
  });
});

describe('meta table', () => {
  it('returns null for a non-existent key', () => {
    expect(getMeta('nonExistentKey')).toBeNull();
  });

  it('stores and retrieves a string value', () => {
    setMeta('myKey', 'myValue');
    expect(getMeta('myKey')).toBe('myValue');
  });

  it('overwrites the value when set again', () => {
    setMeta('counter', '1');
    setMeta('counter', '2');
    expect(getMeta('counter')).toBe('2');
  });

  it('stores the schema_version key on init', () => {
    expect(getMeta('schema_version')).toBe('1');
  });
});

describe('ids_cache table', () => {
  const sampleEntry = {
    cache_key: 'allocine:12345',
    qid: 'Q12345',
    title: 'The Matrix',
    imdb_id: 'tt0133093',
    tmdb_id: '603',
    rt_path: 'm/the_matrix',
    allocine_id: '12345',
  };

  it('returns null for a non-existent cache_key', () => {
    expect(getIdsCacheEntry('nonExistent')).toBeNull();
  });

  it('inserts and retrieves by cache_key', () => {
    upsertIdsCacheEntry(sampleEntry);
    const retrieved = getIdsCacheEntry('allocine:12345');
    expect(retrieved).not.toBeNull();
    expect(retrieved!.qid).toBe('Q12345');
    expect(retrieved!.title).toBe('The Matrix');
    expect(retrieved!.imdb_id).toBe('tt0133093');
    expect(retrieved!.allocine_id).toBe('12345');
  });

  it('upserts when the cache_key already exists', () => {
    upsertIdsCacheEntry(sampleEntry);
    upsertIdsCacheEntry({ ...sampleEntry, imdb_id: 'tt0133094' });
    const retrieved = getIdsCacheEntry('allocine:12345');
    expect(retrieved!.imdb_id).toBe('tt0133094');
  });

  it('retrieves by QID', () => {
    upsertIdsCacheEntry(sampleEntry);
    const retrieved = getIdsCacheEntryByQid('Q12345');
    expect(retrieved).not.toBeNull();
    expect(retrieved!.cache_key).toBe('allocine:12345');
  });

  it('returns null for a non-existent QID', () => {
    expect(getIdsCacheEntryByQid('Q9999999')).toBeNull();
  });

  it('retrieves by title key', () => {
    upsertIdsCacheEntry({ ...sampleEntry, cache_key: 'title:the_matrix:1999' });
    const retrieved = getIdsCacheEntryByTitleKey('the_matrix:1999');
    expect(retrieved).not.toBeNull();
    expect(retrieved!.qid).toBe('Q12345');
  });

  it('prefix-searches by title', () => {
    // The function matches `title:{normalized}:*` — the trailing colon
    // ensures we don't match 'the_matrix_reloaded' when searching for
    // 'the_matrix' (since 'title:the_matrix_reloaded' doesn't start
    // with 'title:the_matrix:').
    upsertIdsCacheEntry({ ...sampleEntry, cache_key: 'title:the_matrix:1999', qid: 'Q1' });
    upsertIdsCacheEntry({ ...sampleEntry, cache_key: 'title:the_matrix:2003', qid: 'Q2' });
    upsertIdsCacheEntry({ ...sampleEntry, cache_key: 'title:the_matrix_reloaded:2003', qid: 'Q3' });

    const results = getIdsCacheEntriesByTitlePrefix('the_matrix');
    // Only 'the_matrix:1999' and 'the_matrix:2003' match — 'the_matrix_reloaded'
    // doesn't (no colon after 'the_matrix').
    expect(results).toHaveLength(2);
    const qids = results.map((r) => r.qid).sort();
    expect(qids).toEqual(['Q1', 'Q2']);
  });

  it('handles null optional fields', () => {
    upsertIdsCacheEntry({
      cache_key: 'title:unknown_film:2024',
      qid: 'Q999',
      title: 'Unknown Film',
    });
    const retrieved = getIdsCacheEntry('title:unknown_film:2024');
    expect(retrieved).not.toBeNull();
    expect(retrieved!.imdb_id).toBeNull();
    expect(retrieved!.tmdb_id).toBeNull();
    expect(retrieved!.rt_path).toBeNull();
    expect(retrieved!.allocine_id).toBeNull();
  });
});

describe('ratings_cache table', () => {
  it('returns null for a non-existent QID', () => {
    expect(getRatingsCacheEntry('Q9999')).toBeNull();
  });

  it('inserts and retrieves a full ratings entry', () => {
    upsertRatingsCacheEntry({
      qid: 'Q123',
      imdb_rating: 7.8,
      imdb_votes: 1234567,
      imdb_url: 'https://www.imdb.com/title/tt0133093/',
      imdb_status: 'ok',
      imdb_status_message: null,
      allocine_press: 3.5,
      allocine_audience: 4.0,
      allocine_votes: 5678,
      allocine_url: 'https://www.allocine.fr/film/fichefilm_gen_cfilm=12345.html',
      allocine_status: 'ok',
      allocine_status_message: null,
      rt_tomatometer: 88,
      rt_certified_fresh: 1,
      rt_url: 'https://www.rottentomatoes.com/m/the_matrix',
      rt_status: 'ok',
      rt_status_message: null,
      fetched_at: '2026-09-19T12:00:00.000Z',
    });

    const retrieved = getRatingsCacheEntry('Q123');
    expect(retrieved).not.toBeNull();
    expect(retrieved!.imdb_rating).toBe(7.8);
    expect(retrieved!.imdb_votes).toBe(1234567);
    expect(retrieved!.allocine_press).toBe(3.5);
    expect(retrieved!.rt_tomatometer).toBe(88);
    expect(retrieved!.rt_certified_fresh).toBe(1);
  });

  it('preserves existing fields on partial update (COALESCE UPSERT)', () => {
    upsertRatingsCacheEntry({
      qid: 'Q456',
      imdb_rating: 7.0,
      imdb_status: 'ok',
      allocine_press: 3.0,
      allocine_status: 'ok',
      rt_tomatometer: 75,
      rt_status: 'ok',
      fetched_at: '2026-09-19T12:00:00.000Z',
    });

    upsertRatingsCacheEntry({
      qid: 'Q456',
      imdb_rating: 7.8,
      imdb_votes: 999,
      imdb_url: 'https://www.imdb.com/title/tt999/',
      imdb_status: 'ok',
      imdb_status_message: null,
      fetched_at: '2026-09-19T13:00:00.000Z',
    });

    const retrieved = getRatingsCacheEntry('Q456');
    expect(retrieved).not.toBeNull();
    expect(retrieved!.imdb_rating).toBe(7.8);
    expect(retrieved!.imdb_votes).toBe(999);
    expect(retrieved!.allocine_press).toBe(3.0);
    expect(retrieved!.allocine_status).toBe('ok');
    expect(retrieved!.rt_tomatometer).toBe(75);
    expect(retrieved!.rt_status).toBe('ok');
  });

  it('handles null fields cleanly', () => {
    upsertRatingsCacheEntry({
      qid: 'Q789',
      imdb_rating: null,
      imdb_votes: null,
      imdb_url: null,
      imdb_status: 'absent',
      imdb_status_message: 'Not in IMDB dataset',
      allocine_press: null,
      allocine_audience: null,
      allocine_votes: null,
      allocine_url: null,
      allocine_status: null,
      allocine_status_message: null,
      rt_tomatometer: null,
      rt_certified_fresh: null,
      rt_url: null,
      rt_status: null,
      rt_status_message: null,
      fetched_at: '2026-09-19T12:00:00.000Z',
    });

    const retrieved = getRatingsCacheEntry('Q789');
    expect(retrieved).not.toBeNull();
    expect(retrieved!.imdb_rating).toBeNull();
    expect(retrieved!.imdb_status).toBe('absent');
    expect(retrieved!.allocine_press).toBeNull();
    expect(retrieved!.rt_tomatometer).toBeNull();
  });
});

describe('imdb_ratings table', () => {
  beforeEach(() => {
    // clearAndBulkInsertImdbRatings takes tuples [tconst, rating, votes]
    // (not objects) — the spread `...row` in the insert statement expects
    // an array, not an object.
    clearAndBulkInsertImdbRatings([
      ['tt0133093', 8.7, 2000000],
      ['tt0234215', 7.5, 350000],
      ['tt0242653', 6.7, 190000],
    ]);
  });

  it('counts the inserted rows correctly', () => {
    expect(getImdbRatingCount()).toBe(3);
  });

  it('retrieves a single rating by tconst', () => {
    const matrix = getImdbRating('tt0133093');
    expect(matrix).not.toBeNull();
    expect(matrix!.rating).toBe(8.7);
    expect(matrix!.votes).toBe(2000000);
  });

  it('returns null for a non-existent tconst', () => {
    expect(getImdbRating('tt0000000')).toBeNull();
  });

  it('retrieves ratings in batch', () => {
    const results = getImdbRatingsBatch(['tt0133093', 'tt9999999', 'tt0234215']);
    expect(results.size).toBe(2);
    expect(results.get('tt0133093')!.rating).toBe(8.7);
    expect(results.get('tt0234215')!.rating).toBe(7.5);
    expect(results.has('tt9999999')).toBe(false);
  });

  it('handles empty batch lookup', () => {
    const results = getImdbRatingsBatch([]);
    expect(results.size).toBe(0);
  });

  it('clears and re-inserts the dataset', () => {
    clearAndBulkInsertImdbRatings([['tt1375666', 8.8, 2300000]]);
    expect(getImdbRatingCount()).toBe(1);
    expect(getImdbRating('tt0133093')).toBeNull();
    expect(getImdbRating('tt1375666')!.rating).toBe(8.8);
  });

  it('handles large rating values without truncation', () => {
    clearAndBulkInsertImdbRatings([
      ['tt0000001', 10.0, 1],
      ['tt0000002', 0.1, 999999999],
    ]);
    const r1 = getImdbRating('tt0000001')!;
    const r2 = getImdbRating('tt0000002')!;
    expect(r1.rating).toBe(10.0);
    expect(r2.rating).toBe(0.1);
    expect(r2.votes).toBe(999999999);
  });
});
