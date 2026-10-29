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
  clearRatingsCache,
  getImdbRating,
  getImdbRatingsBatch,
  getImdbRatingCount,
  clearAndBulkInsertImdbRatings,
  getSchemaVersion,
  isCacheDbAvailable,
} from '../../../src/main/ratings/cacheDb';
import Database from 'better-sqlite3';

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
  it('opens the DB and creates the tables at the current schema version', () => {
    expect(isCacheDbAvailable()).toBe(true);
    expect(getSchemaVersion()).toBe(2);
  });

  it('is idempotent', () => {
    initCacheDb();
    initCacheDb();
    expect(isCacheDbAvailable()).toBe(true);
  });
});

describe('migration v1 → v2: reset poisoned AlloCiné absent entries', () => {
  /** Rebuild a raw v1 database containing a poisoned 'absent' row (the
   *  2026-10-28 AlloCiné bot-mitigation incident), then let initCacheDb
   *  migrate it. */
  function seedV1Db(): void {
    closeCacheDb();
    for (const file of fs.readdirSync(USER_DATA_DIR)) {
      if (file.startsWith('cache.db')) fs.unlinkSync(path.join(USER_DATA_DIR, file));
    }
    const raw = new Database(path.join(USER_DATA_DIR, 'cache.db'));
    raw.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
      CREATE TABLE ratings_cache (
        qid TEXT PRIMARY KEY,
        imdb_rating REAL, imdb_votes INTEGER, imdb_url TEXT,
        imdb_status TEXT, imdb_status_message TEXT,
        allocine_press REAL, allocine_audience REAL, allocine_votes INTEGER,
        allocine_url TEXT, allocine_status TEXT, allocine_status_message TEXT,
        rt_tomatometer INTEGER, rt_certified_fresh INTEGER, rt_url TEXT,
        rt_status TEXT, rt_status_message TEXT,
        fetched_at TEXT NOT NULL
      ) WITHOUT ROWID;
      CREATE TABLE ids_cache (
        cache_key TEXT PRIMARY KEY, qid TEXT NOT NULL, title TEXT NOT NULL,
        imdb_id TEXT, tmdb_id TEXT, rt_path TEXT, allocine_id TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      ) WITHOUT ROWID;
      CREATE TABLE imdb_ratings (tconst TEXT PRIMARY KEY, rating REAL NOT NULL, votes INTEGER NOT NULL) WITHOUT ROWID;
    `);
    raw.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '1')").run();
    // The poisoned row: allocine 'absent' (bogus — the film HAS ratings),
    // imdb + rt data present, fetched_at renewed by Phase 1.5.
    raw.prepare(
      `INSERT INTO ratings_cache
         (qid, imdb_rating, imdb_status, rt_status, allocine_status, allocine_status_message, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run('QPOISON', 7.1, 'ok', 'ok', 'absent', 'Pas de note presse ni spectateurs sur AlloCiné', '2026-10-28T15:56:06.594Z');
    // A healthy row must survive untouched.
    raw.prepare(
      `INSERT INTO ratings_cache
         (qid, imdb_rating, imdb_status, allocine_press, allocine_status, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('QHEALTHY', 8.0, 'ok', 4.2, 'ok', '2026-10-28T15:56:06.594Z');
    raw.close();
  }

  it('clears the allocine columns of absent rows, preserves everything else, stamps v2', () => {
    seedV1Db();
    initCacheDb();

    expect(getMeta('schema_version')).toBe('2');

    const poisoned = getRatingsCacheEntry('QPOISON');
    expect(poisoned).not.toBeNull();
    expect(poisoned!.allocine_status).toBeNull(); // reset → Phase 2 re-scrapes
    expect(poisoned!.allocine_press).toBeNull();
    expect(poisoned!.allocine_status_message).toBeNull();
    expect(poisoned!.imdb_rating).toBe(7.1); // preserved
    expect(poisoned!.imdb_status).toBe('ok');
    expect(poisoned!.rt_status).toBe('ok');
    expect(poisoned!.fetched_at).toBe('2026-10-28T15:56:06.594Z'); // untouched

    const healthy = getRatingsCacheEntry('QHEALTHY');
    expect(healthy!.allocine_status).toBe('ok');
    expect(healthy!.allocine_press).toBe(4.2);
  });
});

describe('meta table', () => {
  it('returns null for a non-existent key', () => {
    expect(getMeta('nope')).toBeNull();
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
    expect(getMeta('schema_version')).toBe('2');
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

  it('clears a stale failure message when the source recovers (status update)', () => {
    // Real regression: AlloCiné 'absent' + message was followed by a retry
    // that recovered to 'ok' — the bare COALESCE kept the old failure
    // message, producing status='ok' + "Pas de note presse ni spectateurs".
    upsertRatingsCacheEntry({
      qid: 'Q777',
      allocine_status: 'absent',
      allocine_status_message: 'Pas de note presse ni spectateurs sur AlloCiné',
      allocine_url: 'https://www.allocine.fr/film/fichefilm_gen_cfilm=1.html',
      fetched_at: '2026-10-28T15:00:00.000Z',
    });

    // Recovery: status becomes 'ok', message empty (source recovered).
    upsertRatingsCacheEntry({
      qid: 'Q777',
      allocine_press: 3.1,
      allocine_status: 'ok',
      allocine_status_message: null,
      fetched_at: '2026-10-29T15:00:00.000Z',
    });

    const retrieved = getRatingsCacheEntry('Q777');
    expect(retrieved!.allocine_status).toBe('ok');
    expect(retrieved!.allocine_status_message).toBeNull();
    expect(retrieved!.allocine_press).toBe(3.1);
  });

  it('preserves the message when no status is provided (partial imdb update)', () => {
    upsertRatingsCacheEntry({
      qid: 'Q888',
      allocine_status: 'absent',
      allocine_status_message: 'Pas de note presse ni spectateurs sur AlloCiné',
      fetched_at: '2026-10-28T15:00:00.000Z',
    });
    // Phase 1.5-style partial update: imdb fields only, no allocine status.
    upsertRatingsCacheEntry({
      qid: 'Q888',
      imdb_rating: 7.2,
      imdb_status: 'ok',
      imdb_status_message: null,
      fetched_at: '2026-10-29T15:00:00.000Z',
    });
    const retrieved = getRatingsCacheEntry('Q888');
    expect(retrieved!.imdb_rating).toBe(7.2);
    expect(retrieved!.allocine_status).toBe('absent');
    expect(retrieved!.allocine_status_message).toBe('Pas de note presse ni spectateurs sur AlloCiné');
  });

  it('clearRatingsCache deletes every row and returns the count', () => {
    upsertRatingsCacheEntry({ qid: 'QA', allocine_status: 'ok', allocine_press: 3.0, fetched_at: '2026-10-29T10:00:00.000Z' });
    upsertRatingsCacheEntry({ qid: 'QB', imdb_status: 'ok', imdb_rating: 7.0, fetched_at: '2026-10-29T10:00:00.000Z' });
    expect(getRatingsCacheEntry('QA')).not.toBeNull();

    const cleared = clearRatingsCache();
    expect(cleared).toBe(2);
    expect(getRatingsCacheEntry('QA')).toBeNull();
    expect(getRatingsCacheEntry('QB')).toBeNull();

    // Idempotent: clearing an empty table returns 0.
    expect(clearRatingsCache()).toBe(0);
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
