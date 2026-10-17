// ──────────────────────────────────────────────────────────────────────────
// IMDB dataset parsing tests — TSV → SQLite pipeline.
//
// Covers the parsing half of `imdbDatasetClient.ts`:
//   - parseLine: the per-row validator (header, malformed, \N, ranges)
//   - readAndParseTsvGz: the streaming gzip Decompressor + line splitter
//     (cross-chunk boundaries AND multi-line chunks)
//   - the TSV → clearAndBulkInsertImdbRatings → getImdbRatingsBatch path:
//     real end-to-end over a gzipped fixture, with a real SQLite cache DB
//     in a temp userData dir (mocked electron, like cacheDb.test.ts).
//
// What this catches:
//   - IMDB dataset schema drift (renamed columns, new column order)
//   - regression in the streaming splitter (chunk-boundary line corruption)
//   - invalid-row poisoning of the imdb_ratings table (bad ratings, \N)
//
// What this misses:
//   - the actual download (fetchWithTimeout) + refresh scheduling — needs
//     network; refreshDataset stays covered only by live usage of the app
//
// Gzip fixtures are built in-memory with zlib at test time — no network.
// ──────────────────────────────────────────────────────────────────────────

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { gzipSync } from 'node:zlib';

const TMP_DIR = path.join(os.tmpdir(), `arvecinema-imdb-parse-test-${process.pid}`);
const USER_DATA_DIR = path.join(TMP_DIR, 'userData');

fs.mkdirSync(USER_DATA_DIR, { recursive: true });

vi.mock('electron', () => ({
  app: {
    getPath: () => USER_DATA_DIR,
  },
}));

vi.mock('../../../src/main/ratings/moduleLoggers', () => ({
  log: new Proxy(
    {},
    { get: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }) },
  ),
}));

import {
  parseLine,
  readAndParseTsvGz,
} from '../../../src/main/ratings/imdbDatasetClient';
import {
  initCacheDb,
  closeCacheDb,
  getImdbRatingCount,
  getImdbRatingsBatch,
  clearAndBulkInsertImdbRatings,
} from '../../../src/main/ratings/cacheDb';

const TSV_HEADER = 'tconst\taverageRating\tnumVotes\n';

/** Build a gzipped TSV fixture on disk, imitating the real
 *  datasets.imdbws.com column order (tconst, averageRating, numVotes).
 *  The parser only reads fields 0..2, so extra/missing columns can't hide
 *  column-order drift. */
function writeGzFixture(name: string, tsv: string): string {
  const file = path.join(TMP_DIR, name);
  fs.writeFileSync(file, gzipSync(Buffer.from(tsv, 'utf-8')));
  return file;
}

beforeEach(() => {
  // Recreate explicitly — TMP_DIR may still exist from a parallel worker,
  // and recursive mkdir of an existing dir does NOT recreate children.
  fs.mkdirSync(USER_DATA_DIR, { recursive: true });
  initCacheDb();
});

afterEach(() => {
  closeCacheDb();
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
});

// ── parseLine — the per-row validator ──────────────────────────────────────

describe('parseLine', () => {
  it('parses a valid row', () => {
    expect(parseLine('tt0111161\t9.3\t2900000')).toEqual(['tt0111161', 9.3, 2900000]);
  });

  it('rejects the header row', () => {
    expect(parseLine('tconst\truntimeMinutes\taverageRating\tnumVotes')).toBeNull();
    expect(parseLine('tconst\taverageRating\tnumVotes')).toBeNull();
  });

  it('rejects empty and whitespace-only lines', () => {
    expect(parseLine('')).toBeNull();
    expect(parseLine('   ')).toBeNull();
  });

  it("rejects rows with missing values (\\N escaping)", () => {
    expect(parseLine('tt0000001\t\\N\t90000')).toBeNull();
    expect(parseLine('tt0000001\t7.1\t\\N')).toBeNull();
  });

  it('rejects non-tconst ids', () => {
    expect(parseLine('mv0000001\t7.1\t90000')).toBeNull();
    expect(parseLine('tt\t7.1\t90000')).toBeNull();
  });

  it('rejects non-numeric values', () => {
    expect(parseLine('tt0000001\tnotanumber\t90000')).toBeNull();
    expect(parseLine('tt0000001\t7.1\tlotsofvotes')).toBeNull();
  });

  it('rejects ratings outside the 0..10 range', () => {
    expect(parseLine('tt0000001\t11.0\t90000')).toBeNull();
    expect(parseLine('tt0000001\t-0.5\t90000')).toBeNull();
  });

  it('allows the edge-of-range ratings 0 and 10', () => {
    expect(parseLine('tt0000001\t10\t500')).toEqual(['tt0000001', 10, 500]);
    expect(parseLine('tt0000001\t0\t500')).toEqual(['tt0000001', 0, 500]);
  });

  it('rejects rows missing fields entirely (undefined votes)', () => {
    expect(parseLine('tt0000001')).toBeNull();
  });
});

// ── readAndParseTsvGz — streaming decompression + splitting ───────────────

describe('readAndParseTsvGz', () => {
  it('parses a small mixed-quality fixture (valid + rejected rows)', async () => {
    const file = writeGzFixture(
      'small.tsv.gz',
      TSV_HEADER +
        'tt0111161\t9.3\t2900000\n' + // valid
        'tt0120737\t6.9\t1800000\n' + // valid
        'tt0000001\t\\N\t90000\n' + // \N rating → dropped
        'mv0000001\t7.1\t90000\n' + // bad id → dropped
        'tt0000002\t99\t90000\n', // out of range → dropped
    );
    const rows = await readAndParseTsvGz(file);
    expect(rows).toEqual([
      ['tt0111161', 9.3, 2900000],
      ['tt0120737', 6.9, 1800000],
    ]);
  });

  it('keeps lines intact across gzip chunk boundaries — 5000 rows', async () => {
    // 5000 rows ≈ 100 KB uncompressed — forces multiple stream chunks so the
    // buffered line-splitter is exercised (a line split across two chunks
    // would previously corrupt into garbage rows).
    const lines: string[] = [TSV_HEADER];
    for (let i = 0; i < 5000; i++) {
      lines.push(`tt${String(1_000_000 + i)}\t6.5\t${1000 + i}\n`);
    }
    const file = writeGzFixture('large.tsv.gz', lines.join(''));
    const rows = await readAndParseTsvGz(file);

    expect(rows).toHaveLength(5000);
    expect(rows[0]).toEqual(['tt1000000', 6.5, 1000]);
    expect(rows[4999]).toEqual(['tt1004999', 6.5, 5999]);
  });

  it('rejects a file that is not valid gzip', async () => {
    const file = writeGzFixturePlain('not-gzip.tsv', 'tconst\taverageRating\tnumVotes\n');
    await expect(readAndParseTsvGz(file)).rejects.toThrow(/parse failed/i);
  });
});

/** Same as writeGzFixture but WITHOUT gzip (raw tsv) — invalid input case. */
function writeGzFixturePlain(name: string, content: string): string {
  const file = path.join(TMP_DIR, name);
  fs.writeFileSync(file, content);
  return file;
}

// ── TSV → SQLite integration (the "TSV → SQLite" part of the TODO) ────────

describe('TSV → SQLite pipeline (parse + bulk insert + batch lookup)', () => {
  it('end-to-end: gzipped dataset → imdb_ratings → batch lookups', async () => {
    const file = writeGzFixture(
      'endtoend.tsv.gz',
      TSV_HEADER +
        'tt0111161\t9.3\t2900000\n' +
        'tt0120737\t6.9\t1800000\n' +
        'tt0000001\t8.1\t42\n' +
        'tt0000001-RANK\t7.0\t420\n', // dropped: not a bare tt<digits> id
    );
    const parsed = await readAndParseTsvGz(file);
    expect(parsed).toHaveLength(3);

    clearAndBulkInsertImdbRatings(parsed);
    expect(getImdbRatingCount()).toBe(3);

    const batch = getImdbRatingsBatch(['tt0111161', 'tt0120737', 'ttMissing']);
    expect(batch.get('tt0111161')).toEqual({ rating: 9.3, votes: 2900000 });
    expect(batch.get('tt0120737')).toEqual({ rating: 6.9, votes: 1800000 });
    expect(batch.has('ttMissing')).toBe(false);
  });

  it('a re-ingestion replaces previous data (clear-and-rebuild semantics)', async () => {
    const first = parseLines(TSV_HEADER + 'tt0111161\t9.3\t1000\n');
    clearAndBulkInsertImdbRatings(first);
    expect(getImdbRatingCount()).toBe(1);

    // Newer dataset with updated numbers + an extra film.
    const second = parseLines(
      TSV_HEADER + 'tt0111161\t9.4\t2000\ntt1375666\t8.6\t2500000\n',
    );
    clearAndBulkInsertImdbRatings(second);
    expect(getImdbRatingCount()).toBe(2); // replaced, not appended
    expect(getImdbRatingsBatch(['tt0111161']).get('tt0111161')).toEqual({ rating: 9.4, votes: 2000 });
  });

  it('an all-invalid input leaves the table EMPTY (poisoning guard)', async () => {
    const invalid = parseLines(TSV_HEADER + 'mv0000\t9.3\t1000\n');
    clearAndBulkInsertImdbRatings(invalid);
    expect(getImdbRatingCount()).toBe(0);
  });
});

// Helper: parse an in-memory TSV (already installed header-first) through
// the real row validator.
function parseLines(tsv: string): Array<[string, number, number]> {
  return tsv
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => l.length > 0)
    .map(parseLine)
    .filter((r): r is [string, number, number] => r !== null);
}
