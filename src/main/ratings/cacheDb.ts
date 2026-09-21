import { app } from 'electron';
import path from 'path';
import fs from 'fs';
import type DatabaseType from 'better-sqlite3';
import { log } from './moduleLoggers';
type Database = DatabaseType.Database;

// ──────────────────────────────────────────────────────────────────────────
// Cache DB — single SQLite store for all ArveCinema caches.
//
// Replaces the previous mix of JSON files + in-memory Maps:
//   - ids-cache.json       → table `ids_cache`
//   - ratings-cache.json   → table `ratings_cache`
//   - imdb-ratings.db      → table `imdb_ratings` (was separate DB)
//
// All in one SQLite file: `cache.db` in the user data dir.
//
// Why SQLite for everything?
//   - No JSON.parse of multi-MB files on startup (was a noticeable delay)
//   - Transactional consistency (e.g. update ratings + IDs atomically)
//   - Better concurrent reads (WAL mode)
//   - Sub-millisecond lookups via primary key
//   - One file to back up / inspect / delete
//   - Migration: old JSON files are auto-imported on first launch
// ──────────────────────────────────────────────────────────────────────────

const DB_FILENAME = 'cache.db';

let DatabaseCtor: typeof DatabaseType | null = null;
try {
  DatabaseCtor = require('better-sqlite3');
} catch (err) {
  log.cacheDb.warn(
    `[cache-db] better-sqlite3 failed to load — caching will be unavailable. ` +
    `Run \`npm install\` then \`npm run postinstall\` to rebuild native modules. ` +
    `Error: ${err instanceof Error ? err.message : String(err)}`,
  );
}

/** Format a timestamp for debug logs: HH:MM:ss.sss */
function ts(): string {
  const d = new Date();
  return d.toLocaleTimeString('en-GB', { hour12: false }) + '.' + String(d.getMilliseconds()).padStart(3, '0');
}

let db: Database | null = null;

function dbPath(): string {
  return path.join(app.getPath('userData'), DB_FILENAME);
}

/** Open (or create) the cache DB. Idempotent — returns the cached handle. */
function openDb(): Database | null {
  if (db) return db;
  if (!DatabaseCtor) return null;
  db = new DatabaseCtor(dbPath());
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('cache_size = -32000');   // 32 MB cache
  db.pragma('temp_store = MEMORY');
  // Create the meta table first — we need it to read the schema version
  // before creating any other tables.
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key    TEXT PRIMARY KEY,
      value  TEXT NOT NULL
    ) WITHOUT ROWID;
  `);
  return db;
}

// ── Schema versioning + migrations ──────────────────────────────────────────
//
// The `meta` table stores `schema_version` as an integer. On startup,
// `initCacheDb()` compares the stored version against `SCHEMA_VERSION`:
//
//   1. Stored === SCHEMA_VERSION → no action needed (normal case)
//   2. Stored < SCHEMA_VERSION → forward migration: run each migration
//      function in sequence (v1→v2, v2→v3, ...). Data is preserved.
//   3. Stored > SCHEMA_VERSION → incompatible (user downgraded the app).
//      Drop all tables and rebuild from scratch. Data is lost — the app
//      will re-download the IMDB dataset and re-scrape Wikidata/AC/RT.
//   4. No stored version (fresh install) → create all tables at the
//      current schema version.
//
// Each migration function receives the open DB handle and runs within a
// transaction. If any migration throws, the transaction rolls back and
// we fall back to the nuclear option: drop all tables and rebuild.

/** Current schema version. Bump this when the schema changes.
 *  Migration functions for each version bump are defined below. */
const SCHEMA_VERSION = 1;

/** Read the stored schema version from the meta table.
 *  Returns 0 if the meta table doesn't exist yet (fresh install). */
function getStoredSchemaVersion(): number {
  if (!db) return 0;
  try {
    const row = db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version') as
      | { value: string }
      | undefined;
    return row ? Number(row.value) : 0;
  } catch {
    // Meta table doesn't exist yet — fresh install.
    return 0;
  }
}

/** Write the schema version to the meta table. */
function setStoredSchemaVersion(version: number): void {
  if (!db) return;
  db.prepare(
    'INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)',
  ).run('schema_version', String(version));
}

/** Create all tables for the current schema version (v1).
 *  Used on fresh installs and after a nuclear rebuild. */
function createAllTablesV1(): void {
  if (!db) return;
  db.exec(`
    -- Wikidata ID resolution cache (permanent — IDs don't change).
    -- Keyed by either allocine:NNN or title:NORMALIZED_TITLE:YYYY
    CREATE TABLE IF NOT EXISTS ids_cache (
      cache_key   TEXT PRIMARY KEY,
      qid         TEXT NOT NULL,
      title       TEXT NOT NULL,
      imdb_id     TEXT,
      tmdb_id     TEXT,
      rt_path     TEXT,
      allocine_id TEXT,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    ) WITHOUT ROWID;

    -- Scraped ratings cache (24h TTL).
    -- Keyed by QID. Each row holds all source ratings (IMDB, AlloCiné, RT).
    CREATE TABLE IF NOT EXISTS ratings_cache (
      qid            TEXT PRIMARY KEY,
      -- IMDB
      imdb_rating        REAL,
      imdb_votes         INTEGER,
      imdb_url           TEXT,
      imdb_status        TEXT,
      imdb_status_message TEXT,
      -- AlloCiné
      allocine_press      REAL,
      allocine_audience   REAL,
      allocine_votes      INTEGER,
      allocine_url        TEXT,
      allocine_status     TEXT,
      allocine_status_message TEXT,
      -- RT
      rt_tomatometer      INTEGER,
      rt_certified_fresh  INTEGER,
      rt_url              TEXT,
      rt_status           TEXT,
      rt_status_message   TEXT,
      -- Metadata
      fetched_at       TEXT NOT NULL
    ) WITHOUT ROWID;

    -- IMDB dataset ratings (1.71M rows, 36h refresh, see imdbDatasetClient.ts).
    CREATE TABLE IF NOT EXISTS imdb_ratings (
      tconst  TEXT PRIMARY KEY,
      rating  REAL NOT NULL,
      votes   INTEGER NOT NULL
    ) WITHOUT ROWID;

    -- Index for the secondary lookup path: title → ids_cache by QID.
    CREATE INDEX IF NOT EXISTS idx_ids_cache_qid ON ids_cache(qid);
  `);
  setStoredSchemaVersion(SCHEMA_VERSION);
}

/** Drop all tables (nuclear option — used on incompatible downgrade). */
function dropAllTables(): void {
  if (!db) return;
  log.cacheDb.warn(`[${ts()}] [cache-db] incompatible schema version — dropping all tables and rebuilding from scratch`);
  db.exec(`
    DROP TABLE IF EXISTS ids_cache;
    DROP TABLE IF EXISTS ratings_cache;
    DROP TABLE IF EXISTS imdb_ratings;
    DROP INDEX IF EXISTS idx_ids_cache_qid;
    -- Keep the meta table — we'll write the new schema_version into it.
    DELETE FROM meta WHERE key != 'schema_version';
  `);
}

/** Run schema migrations. Called from initCacheDb() after openDb(). */
function runMigrations(): void {
  if (!db) return;
  const stored = getStoredSchemaVersion();

  if (stored === 0) {
    // Fresh install — no meta table existed before openDb() created it.
    log.cacheDb.info(`[${ts()}] [cache-db] fresh install — creating schema v${SCHEMA_VERSION}`);
    createAllTablesV1();
    return;
  }

  if (stored === SCHEMA_VERSION) {
    // Normal case — schema is up to date.
    return;
  }

  if (stored > SCHEMA_VERSION) {
    // Incompatible: user downgraded the app, the DB has a newer schema
    // than this code knows how to handle. Nuclear option: drop and rebuild.
    log.cacheDb.warn(
      `[cache-db] DB schema v${stored} > app schema v${SCHEMA_VERSION} ` +
      `(user downgraded?) — dropping all tables and rebuilding`,
    );
    dropAllTables();
    createAllTablesV1();
    return;
  }

  // stored < SCHEMA_VERSION → forward migration.
  // Run each migration function in sequence within a transaction.
  // If any migration throws, roll back and fall back to nuclear rebuild.
  log.cacheDb.info(`[${ts()}] [cache-db] migrating schema v${stored} → v${SCHEMA_VERSION}`);
  try {
    db.transaction(() => {
      // ── Migration: v0 → v1 ──────────────────────────────────────────
      // This is the initial schema creation for existing DBs that were
      // created before the versioning system was added (0.6.x). The
      // tables already exist (created by the old openDb), so we just
      // need to stamp the version.
      if (stored < 1) {
        log.cacheDb.info(`[${ts()}] [cache-db] migration v0 → v1: stamping schema version`);
        // Tables already exist from the old code — just verify they're
        // present and stamp the version.
        const tables = db!.prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('ids_cache', 'ratings_cache', 'imdb_ratings')",
        ).all() as Array<{ name: string }>;
        const tableNames = new Set(tables.map(t => t.name));
        if (!tableNames.has('ids_cache') || !tableNames.has('ratings_cache') || !tableNames.has('imdb_ratings')) {
          // Some tables are missing — create all of them (CREATE IF NOT EXISTS is safe).
          createAllTablesV1();
        } else {
          setStoredSchemaVersion(1);
        }
      }

      // ── Future migrations go here ───────────────────────────────────
      // Example for when we bump to v2:
      //
      // if (stored < 2) {
      //   log.cacheDb.info('[cache-db] migration v1 → v2: adding new_column to ratings_cache');
      //   db.exec('ALTER TABLE ratings_cache ADD COLUMN new_column TEXT');
      //   setStoredSchemaVersion(2);
      // }
    })();
    log.cacheDb.info(`[${ts()}] [cache-db] migration complete — now at v${SCHEMA_VERSION}`);
  } catch (err) {
    // Migration failed — nuclear rebuild.
    log.cacheDb.error('[cache-db] migration failed, rebuilding from scratch:' + " " + (err instanceof Error ? err.message : String(err)));
    dropAllTables();
    createAllTablesV1();
  }
}

// ── Meta table ────────────────────────────────────────────────────────────

export function getMeta(key: string): string | null {
  const d = openDb();
  if (!d) return null;
  const row = d.prepare('SELECT value FROM meta WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

export function setMeta(key: string, value: string): void {
  const d = openDb();
  if (!d) return;
  d.prepare(
    'INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)',
  ).run(key, value);
}

// ── IDs cache ─────────────────────────────────────────────────────────────

export interface IdsCacheRow {
  cache_key: string;
  qid: string;
  title: string;
  imdb_id: string | null;
  tmdb_id: string | null;
  rt_path: string | null;
  allocine_id: string | null;
  created_at: string;
}

/** Look up an IDs cache entry by its cache_key (e.g. "allocine:55774" or "title:cars:2006"). */
export function getIdsCacheEntry(cacheKey: string): IdsCacheRow | null {
  const d = openDb();
  if (!d) return null;
  return (d.prepare('SELECT * FROM ids_cache WHERE cache_key = ?').get(cacheKey) as IdsCacheRow | undefined) ?? null;
}

/** Look up an IDs cache entry by its title key (e.g. "title:cars:2006").
 *  This is the secondary lookup path used by the enricher when allocine ID isn't available. */
export function getIdsCacheEntryByTitleKey(titleKey: string): IdsCacheRow | null {
  return getIdsCacheEntry(`title:${titleKey}`);
}

/** Look up an IDs cache entry by QID. Used by the dataset refresh callback
 *  to find the cached entry for a movie when we only have its QID. */
export function getIdsCacheEntryByQid(qid: string): IdsCacheRow | null {
  const d = openDb();
  if (!d) return null;
  return (d.prepare('SELECT * FROM ids_cache WHERE qid = ? LIMIT 1').get(qid) as IdsCacheRow | undefined) ?? null;
}

/** Look up IDs cache entries by title prefix (partial cache_key match).
 *  Used when a cinema has no allocine ID and no release year — we search
 *  for any entry that another cinema already resolved for the same title.
 *  Returns all matching rows (caller disambiguates if multiple). */
export function getIdsCacheEntriesByTitlePrefix(
  normalizedTitle: string,
): IdsCacheRow[] {
  const d = openDb();
  if (!d) return [];
  // Match any cache_key starting with "title:{normalizedTitle}:"
  // (the trailing colon + anything after it is the year, which we ignore).
  const pattern = `title:${normalizedTitle}:%`;
  return d.prepare(
    'SELECT * FROM ids_cache WHERE cache_key LIKE ?',
  ).all(pattern) as IdsCacheRow[];
}

/** Insert or replace an IDs cache entry. */
export function upsertIdsCacheEntry(entry: {
  cache_key: string;
  qid: string;
  title: string;
  imdb_id?: string | null;
  tmdb_id?: string | null;
  rt_path?: string | null;
  allocine_id?: string | null;
}): void {
  const d = openDb();
  if (!d) return;
  d.prepare(`
    INSERT OR REPLACE INTO ids_cache
      (cache_key, qid, title, imdb_id, tmdb_id, rt_path, allocine_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `).run(
    entry.cache_key,
    entry.qid,
    entry.title,
    entry.imdb_id ?? null,
    entry.tmdb_id ?? null,
    entry.rt_path ?? null,
    entry.allocine_id ?? null,
  );
}

// ── Ratings cache ─────────────────────────────────────────────────────────

export interface RatingsCacheRow {
  qid: string;
  imdb_rating: number | null;
  imdb_votes: number | null;
  imdb_url: string | null;
  imdb_status: string | null;
  imdb_status_message: string | null;
  allocine_press: number | null;
  allocine_audience: number | null;
  allocine_votes: number | null;
  allocine_url: string | null;
  allocine_status: string | null;
  allocine_status_message: string | null;
  rt_tomatometer: number | null;
  rt_certified_fresh: number | null;
  rt_url: string | null;
  rt_status: string | null;
  rt_status_message: string | null;
  fetched_at: string;
}

export function getRatingsCacheEntry(qid: string): RatingsCacheRow | null {
  const d = openDb();
  if (!d) return null;
  return (d.prepare('SELECT * FROM ratings_cache WHERE qid = ?').get(qid) as RatingsCacheRow | undefined) ?? null;
}

export function upsertRatingsCacheEntry(entry: Partial<RatingsCacheRow> & { qid: string }): void {
  const d = openDb();
  if (!d) return;

  // CRITICAL: use ON CONFLICT DO UPDATE (true UPSERT) — NOT INSERT OR REPLACE.
  //
  // INSERT OR REPLACE deletes the existing row and inserts a new one with
  // only the columns we pass — unspecified columns get NULL (their DEFAULT).
  // This caused a regression where Phase 1.5 (IMDB dataset lookup) wrote a
  // row with just imdb_rating + fetched_at, which then "looked fresh" to
  // Phase 2's `isFresh()` check, so Phase 2 skipped AlloCiné + RT scraping
  // entirely. Result: AC and RT ratings disappeared.
  //
  // ON CONFLICT DO UPDATE only modifies the columns we explicitly set in
  // the SET clause — unspecified columns are preserved.
  //
  // We use COALESCE to fall back to the existing column value when the
  // caller passes null/undefined for a field. This way callers can pass
  // partial updates ("just update IMDB fields") without clobbering AC/RT.
  d.prepare(`
    INSERT INTO ratings_cache (
      qid,
      imdb_rating, imdb_votes, imdb_url, imdb_status, imdb_status_message,
      allocine_press, allocine_audience, allocine_votes, allocine_url,
      allocine_status, allocine_status_message,
      rt_tomatometer, rt_certified_fresh, rt_url, rt_status, rt_status_message,
      fetched_at
    ) VALUES (
      @qid,
      @imdb_rating, @imdb_votes, @imdb_url, @imdb_status, @imdb_status_message,
      @allocine_press, @allocine_audience, @allocine_votes, @allocine_url,
      @allocine_status, @allocine_status_message,
      @rt_tomatometer, @rt_certified_fresh, @rt_url, @rt_status, @rt_status_message,
      COALESCE(@fetched_at, datetime('now'))
    )
    ON CONFLICT(qid) DO UPDATE SET
      imdb_rating = COALESCE(@imdb_rating, imdb_rating),
      imdb_votes = COALESCE(@imdb_votes, imdb_votes),
      imdb_url = COALESCE(@imdb_url, imdb_url),
      imdb_status = COALESCE(@imdb_status, imdb_status),
      imdb_status_message = COALESCE(@imdb_status_message, imdb_status_message),
      allocine_press = COALESCE(@allocine_press, allocine_press),
      allocine_audience = COALESCE(@allocine_audience, allocine_audience),
      allocine_votes = COALESCE(@allocine_votes, allocine_votes),
      allocine_url = COALESCE(@allocine_url, allocine_url),
      allocine_status = COALESCE(@allocine_status, allocine_status),
      allocine_status_message = COALESCE(@allocine_status_message, allocine_status_message),
      rt_tomatometer = COALESCE(@rt_tomatometer, rt_tomatometer),
      rt_certified_fresh = CASE
        WHEN @rt_certified_fresh IS NULL THEN rt_certified_fresh
        ELSE @rt_certified_fresh
      END,
      rt_url = COALESCE(@rt_url, rt_url),
      rt_status = COALESCE(@rt_status, rt_status),
      rt_status_message = COALESCE(@rt_status_message, rt_status_message),
      fetched_at = COALESCE(@fetched_at, datetime('now'))
  `).run({
    qid: entry.qid,
    imdb_rating: entry.imdb_rating ?? null,
    imdb_votes: entry.imdb_votes ?? null,
    imdb_url: entry.imdb_url ?? null,
    imdb_status: entry.imdb_status ?? null,
    imdb_status_message: entry.imdb_status_message ?? null,
    allocine_press: entry.allocine_press ?? null,
    allocine_audience: entry.allocine_audience ?? null,
    allocine_votes: entry.allocine_votes ?? null,
    allocine_url: entry.allocine_url ?? null,
    allocine_status: entry.allocine_status ?? null,
    allocine_status_message: entry.allocine_status_message ?? null,
    rt_tomatometer: entry.rt_tomatometer ?? null,
    // Note: rt_certified_fresh uses 0/1 (INTEGER) — we can't tell "false"
    // from "unset" with NULL semantics, so we treat NULL as "preserve".
    rt_certified_fresh: entry.rt_certified_fresh === undefined ? null : (entry.rt_certified_fresh ? 1 : 0),
    rt_url: entry.rt_url ?? null,
    rt_status: entry.rt_status ?? null,
    rt_status_message: entry.rt_status_message ?? null,
    fetched_at: entry.fetched_at ?? new Date().toISOString(),
  });
}

// ── IMDB dataset (in same DB) ─────────────────────────────────────────────

export function getImdbRating(tconst: string): { rating: number; votes: number } | null {
  const d = openDb();
  if (!d) return null;
  const row = d.prepare(
    'SELECT rating, votes FROM imdb_ratings WHERE tconst = ?',
  ).get(tconst) as { rating: number; votes: number } | undefined;
  return row ?? null;
}

export function getImdbRatingsBatch(
  tconsts: string[],
): Map<string, { rating: number; votes: number }> {
  const result = new Map<string, { rating: number; votes: number }>();
  const d = openDb();
  if (!d || tconsts.length === 0) return result;
  const BATCH = 500;  // SQLite param limit is ~999
  for (let i = 0; i < tconsts.length; i += BATCH) {
    const slice = tconsts.slice(i, i + BATCH);
    const placeholders = slice.map(() => '?').join(',');
    const rows = d.prepare(
      `SELECT tconst, rating, votes FROM imdb_ratings WHERE tconst IN (${placeholders})`,
    ).all(...slice) as Array<{ tconst: string; rating: number; votes: number }>;
    for (const row of rows) {
      result.set(row.tconst, { rating: row.rating, votes: row.votes });
    }
  }
  return result;
}

export function getImdbRatingCount(): number {
  const d = openDb();
  if (!d) return 0;
  const row = d.prepare('SELECT COUNT(*) as count FROM imdb_ratings').get() as { count: number };
  return row.count;
}

export function clearAndBulkInsertImdbRatings(
  rows: Array<[string, number, number]>,
): void {
  const d = openDb();
  if (!d) return;
  const insert = d.prepare(
    'INSERT OR REPLACE INTO imdb_ratings (tconst, rating, votes) VALUES (?, ?, ?)',
  );
  const insertMany = d.transaction((batch: Array<[string, number, number]>) => {
    for (const row of batch) insert.run(...row);
  });
  // Clear first, then insert in batches of 10k to keep memory bounded.
  d.exec('DELETE FROM imdb_ratings');
  const BATCH = 10000;
  for (let i = 0; i < rows.length; i += BATCH) {
    insertMany(rows.slice(i, i + BATCH));
  }
}

// ── Migration from old JSON cache files ────────────────────────────────────

/** Migrate the old `ids-cache.json` and `ratings-cache.json` files to
 *  SQLite if they exist. Called once on app startup (after openDb).
 *  The JSON files are renamed to `.archived` so we don't re-import them. */
export function migrateJsonCaches(): void {
  const d = openDb();
  if (!d) return;
  const dir = app.getPath('userData');

  // ids-cache.json
  const idsPath = path.join(dir, 'ids-cache.json');
  if (fs.existsSync(idsPath)) {
    try {
      const json = JSON.parse(fs.readFileSync(idsPath, 'utf-8')) as Record<string, {
        qid: string; title: string;
        imdbId?: string; tmdbId?: string; rtPath?: string; allocineId?: string;
      }>;
      const insertMany = d.transaction(() => {
        for (const [cacheKey, entry] of Object.entries(json)) {
          upsertIdsCacheEntry({
            cache_key: cacheKey,
            qid: entry.qid,
            title: entry.title,
            imdb_id: entry.imdbId ?? null,
            tmdb_id: entry.tmdbId ?? null,
            rt_path: entry.rtPath ?? null,
            allocine_id: entry.allocineId ?? null,
          });
        }
      });
      insertMany();
      // Archive the JSON file so we don't re-import on next launch.
      fs.renameSync(idsPath, `${idsPath}.archived`);
      log.cacheDb.info(`[${ts()}] [cache-db] migrated ${Object.keys(json).length} IDs from JSON → SQLite`);
    } catch (err) {
      log.cacheDb.warn(`[${ts()}] [cache-db] failed to migrate ids-cache.json:` + " " + (err instanceof Error ? err.message : String(err)));
    }
  }

  // ratings-cache.json
  const ratingsPath = path.join(dir, 'ratings-cache.json');
  if (fs.existsSync(ratingsPath)) {
    try {
      const json = JSON.parse(fs.readFileSync(ratingsPath, 'utf-8')) as Record<string, {
        imdbRating?: number; imdbVotes?: number; imdbUrl?: string;
        imdbStatus?: string; imdbStatusMessage?: string;
        allocinePress?: number; allocineAudience?: number; allocineVotes?: number;
        allocineUrl?: string; allocineStatus?: string; allocineStatusMessage?: string;
        rtTomatometer?: number; rtCertifiedFresh?: boolean;
        rtUrl?: string; rtStatus?: string; rtStatusMessage?: string;
        fetchedAt: string;
      }>;
      const insertMany = d.transaction(() => {
        for (const [qid, entry] of Object.entries(json)) {
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
      });
      insertMany();
      fs.renameSync(ratingsPath, `${ratingsPath}.archived`);
      log.cacheDb.info(`[${ts()}] [cache-db] migrated ${Object.keys(json).length} ratings from JSON → SQLite`);
    } catch (err) {
      log.cacheDb.warn(`[${ts()}] [cache-db] failed to migrate ratings-cache.json:` + " " + (err instanceof Error ? err.message : String(err)));
    }
  }

  // imdb-ratings.db (was separate DB in 0.5.0) → migrate to imdb_ratings table
  const oldImdbDbPath = path.join(dir, 'imdb-ratings.db');
  if (fs.existsSync(oldImdbDbPath)) {
    try {
      const oldDb = new DatabaseCtor!(oldImdbDbPath, { readonly: true });
      const count = oldDb.prepare('SELECT COUNT(*) as count FROM ratings').get() as { count: number };
      if (count.count > 0) {
        // Stream from old DB → new DB
        const stmt = oldDb.prepare('SELECT tconst, rating, votes FROM ratings');
        const insertMany = d.transaction((rows: Array<[string, number, number]>) => {
          const ins = d.prepare('INSERT OR REPLACE INTO imdb_ratings (tconst, rating, votes) VALUES (?, ?, ?)');
          for (const r of rows) ins.run(r[0], r[1], r[2]);
        });
        const BATCH = 10000;
        let batch: Array<[string, number, number]> = [];
        for (const row of stmt.iterate() as Iterable<{ tconst: string; rating: number; votes: number }>) {
          batch.push([row.tconst, row.rating, row.votes]);
          if (batch.length >= BATCH) {
            insertMany(batch);
            batch = [];
          }
        }
        if (batch.length > 0) insertMany(batch);
        log.cacheDb.info(`[${ts()}] [cache-db] migrated ${count.count} IMDB ratings from old imdb-ratings.db → SQLite`);
      }
      oldDb.close();
      // Archive the old DB file.
      try {
        // Also archive the .db-wal and .db-shm sidecar files if present.
        for (const suffix of ['', '-wal', '-shm']) {
          const p = `${oldImdbDbPath}${suffix}`;
          if (fs.existsSync(p)) fs.renameSync(p, `${p}.archived`);
        }
      } catch { /* ignore */ }
    } catch (err) {
      log.cacheDb.warn(`[${ts()}] [cache-db] failed to migrate old imdb-ratings.db:` + " " + (err instanceof Error ? err.message : String(err)));
    }
  }
}

// ── Init ──────────────────────────────────────────────────────────────────

let initialized = false;

/** Open the DB, run schema migrations, migrate old JSON files.
 *  Call once at app startup. */
export function initCacheDb(): void {
  if (initialized) return;
  initialized = true;
  openDb();
  runMigrations();
  migrateJsonCaches();
}

/** Returns the current schema version of the code (not the DB).
 *  Useful for diagnostics — the stored version is in the meta table. */
export function getSchemaVersion(): number {
  return SCHEMA_VERSION;
}

/** Returns the schema version stored in the DB, or 0 if not yet initialized.
 *  Useful for diagnostics — compare against getSchemaVersion() to check
 *  if the DB needs migration. */
export function getStoredSchemaVersionExport(): number {
  return getStoredSchemaVersion();
}

/** Returns true if the DB has been opened successfully. */
export function isCacheDbAvailable(): boolean {
  return db !== null;
}

/** Close the DB connection. Called during graceful shutdown to flush WAL
 *  and release the file handle. After this call, all cache functions will
 *  return null/empty — the app is shutting down. */
export function closeCacheDb(): void {
  if (db) {
    try {
      db.pragma('wal_checkpoint(TRUNCATE)');
      db.close();
    } catch (err) {
      log.cacheDb.warn('[cache-db] error during close:' + " " + (err instanceof Error ? err.message : String(err)));
    }
    db = null;
  }
  initialized = false;
}
