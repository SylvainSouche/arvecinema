// ──────────────────────────────────────────────────────────────────────────
// IMDB ratings table — performance profile + ingest correctness.
//
// Two modes:
//   npm test                 → only the CHEAP tests run (~100ms): a small
//                              (10k row) ingest correctness check + DB
//                              sanity.
//   IMDB_BENCH=1 npm test    → additionally generate a synthetic full-size
//                              dataset (~1.5M rows, mirrors the real
//                              title.ratings.tsv.gz ≈ 8 MB / 1.71M rows)
//                              and MEASURE: parse throughput, ingest time,
//                              table size, batch lookups. Adds ~15-25s —
//                              CI runs without it.
//
// Results recorded (M3 Max, 2026-10): see TODO.md → Performance, and
// CHANGELOG. Headline: WITHOUT ROWID PK covers all columns → lookups are
// b-tree seeks (a covering index is impossible to add and a bloom filter
// cannot beat a PK seek); the real cost was ingest memory, fixed by the
// chunked streaming path used here.
//
// What this catches:
//   - ingest regressions from schema/schemaVersion changes (smoke ingest)
//   - lookup path breakage (try WITHOUT ROWID → ordinary row table)
// ──────────────────────────────────────────────────────────────────────────

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';

const BENCH_ENABLED = process.env.IMDB_BENCH === '1';
/** Full-bench dataset size (mirrors the real 1.71M-row dataset). */
const BENCH_ROWS = Number(process.env.IMDB_BENCH_ROWS ?? 1_500_000);
const SMOKE_ROWS = 10_000;

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'arvecinema-imdb-perf-'));

vi.mock('electron', () => ({
  app: {
    getPath: () => path.join(TMP_DIR, 'userData'),
    isPackaged: false,
  },
}));

import {
  initCacheDb,
  closeCacheDb,
  getImdbRatingsBatch,
  getImdbRating,
  getImdbRatingCount,
  startImdbRatingsBulkIngest,
} from '../../../src/main/ratings/cacheDb';
import { parseLine, readAndParseTsvGz } from '../../../src/main/ratings/imdbDatasetClient';

function makeTsv(lineCount: number): string {
  const lines: string[] = ['tconst\taverageRating\tnumVotes\n'];
  let seed = 42;
  const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let i = 0; i < lineCount; i++) {
    const rating = Math.floor(rand() * 100) / 10;
    const votes = 50 + Math.floor(rand() * 3_000_000);
    lines.push(`tt${1_000_000 + i}\t${rating.toFixed(1)}\t${votes}\n`);
  }
  return lines.join('');
}

/** Build a gzipped synthetic TSV fixture — mirrors title.ratings.tsv.gz. */
function writeFixture(name: string, rowCount: number): string {
  const file = path.join(TMP_DIR, name);
  fs.writeFileSync(file, gzipSync(Buffer.from(makeTsv(rowCount), 'utf-8')));
  return file;
}

beforeAll(() => {
  fs.mkdirSync(path.join(TMP_DIR, 'userData', 'logs'), { recursive: true });
  initCacheDb();
});

afterAll(() => {
  closeCacheDb();
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
});

// ── Cheap, always-on tests ─────────────────────────────────────────────────

describe('imdb_ratings: ingest + lookup correctness (small fixture)', () => {
  it('streaming ingest of 10k rows replaces the table; lookups round-trip', async () => {
    const file = writeFixture('smoke.tsv.gz', SMOKE_ROWS);
    const rows = await readAndParseTsvGz(file);
    expect(rows).toHaveLength(SMOKE_ROWS);

    const session = startImdbRatingsBulkIngest();
    session.insert(rows);
    session.finish();

    expect(getImdbRatingCount()).toBe(SMOKE_ROWS);

    // Point lookups return exactly the generated values.
    const first = parseLine(makeTsv(2).split('\n')[1]);
    expect(first?.[0]).toBe('tt1000000');
    const single = getImdbRating('tt1000000');
    expect(single).toEqual({ rating: rows[0][1], votes: rows[0][2] });

    const batch = getImdbRatingsBatch(['tt1000000', 'tt1000001', 'tt9999999']);
    expect(batch).toHaveLength(2);
    expect(batch.get('tt1000000')).toEqual({ rating: rows[0][1], votes: rows[0][2] });

    // Re-ingest replaces (not appends).
    const session2 = startImdbRatingsBulkIngest();
    session2.insert([[('tt1'), 5.5, 1]]);
    session2.finish();
    expect(getImdbRatingCount()).toBe(1);
  });

  it('abort mid-ingest leaves the ORIGINAL table intact (atomic replace)', async () => {
    // Seed a known state.
    const session = startImdbRatingsBulkIngest();
    session.insert([['tt1', 5.5, 1]]);
    session.finish();
    expect(getImdbRating('tt1')).toEqual({ rating: 5.5, votes: 1 });

    // Ingest some rows, then abort — rollback isolates the DELETE too.
    const session2 = startImdbRatingsBulkIngest();
    session2.insert([['tt100', 7.0, 100_000]]);
    session2.abort();

    expect(getImdbRatingCount()).toBe(1); // DELETE rolled back too
    expect(getImdbRating('tt1')).toEqual({ rating: 5.5, votes: 1 });
    expect(getImdbRating('tt1000')).toBeNull();
  });
});

// ── Full benchmarks (IMDB_BENCH=1) ────────────────────────────────────────

describe.skipIf(!BENCH_ENABLED)(
  'imdb_ratings: full-scale perf profile (IMDB_BENCH=1, ~1.5M rows)',
  () => {
    it(
      `generate ${BENCH_ROWS}-row fixture → parse throughput, ingest, size, lookups`,
      { timeout: 300_000 },
      async () => {
        const file = writeFixture('bench.tsv.gz', BENCH_ROWS);
        output(`fixture: ${BENCH_ROWS} rows, ${(fs.statSync(file).size / 1024 / 1024).toFixed(1)} MB gzipped`);

        // ── Parse (no DB) — gunzip + split + parseLine throughput. ──
        const parseStart = performance.now();
        const rows = await readAndParseTsvGz(file);
        const parseMs = performance.now() - parseStart;
        output(
          `parse-only: ${parseMs.toFixed(0)} ms → ` +
            `${Math.round((rows.length / parseMs) * 1000).toLocaleString()} rows/s`,
        );
        expect(rows).toHaveLength(BENCH_ROWS);

        // ── Streaming ingest — chunks through startImdbRatingsBulkIngest. ──
        const ingestStart = performance.now();
        const session = startImdbRatingsBulkIngest();
        const CHUNK = 100_000;
        for (let i = 0; i < rows.length; i += CHUNK) {
          session.insert(rows.slice(i, rows.length < i + CHUNK ? rows.length : i + CHUNK));
        }
        session.finish();
        const ingestMs = performance.now() - ingestStart;
        output(
          `streaming ingest: ${ingestMs.toFixed(0)} ms → ` +
            `${Math.round((rows.length / ingestMs) * 1000).toLocaleString()} rows/s inserted`,
        );

        // Table size on disk (main db + wal).
        const dbFile = path.join(TMP_DIR, 'userData', 'cache.db');
        const wal = dbFile + '-wal';
        output(
          `table size: ${(fs.statSync(dbFile).size / 1024 / 1024).toFixed(1)} MB db` +
            ` + ${fs.existsSync(wal) ? (fs.statSync(wal).size / 1024 / 1024).toFixed(1) : '0'} MB wal`,
        );

        // ── Lookups — the daily path (day view ≈ 60 titles). ──
        const sampleIds: string[] = [];
        let seed = 4242;
        const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
        for (let i = 0; i < 60; i++) {
          sampleIds.push(`tt${1_000_000 + Math.floor(rand() * BENCH_ROWS)}`);
        }
        const LOOKUP_ITER = 100;
        let hits = 0;
        const batchStart = performance.now();
        for (let i = 0; i < LOOKUP_ITER; i++) {
          hits += getImdbRatingsBatch(sampleIds).size;
        }
        const batchMs = (performance.now() - batchStart) / LOOKUP_ITER;
        output(
          `getImdbRatingsBatch(60 ids): ${batchMs.toFixed(3)} ms/call` +
            ` (avg of ${LOOKUP_ITER}), hits/call ${Math.round(hits / LOOKUP_ITER)}`,
        );

        let singleTotal = 0;
        for (let i = 0; i < 1000; i++) {
          const t1 = performance.now();
          getImdbRating(sampleIds[i % 60]);
          singleTotal += performance.now() - t1;
        }
        output(`getImdbRating(single): ${(singleTotal / 1000).toFixed(3)} ms/call`);

        // Loose sanity (machine-independent): 60 PK index seeks must be < 5ms.
        expect(batchMs).toBeLessThan(5);
        expect(hits / LOOKUP_ITER).toBeGreaterThan(50); // ~60 − LCG collisions
      },
    );
  },
);

function output(msg: string): void {
  process.stdout.write(`[imdb-perf] ${msg}\n`);
}
