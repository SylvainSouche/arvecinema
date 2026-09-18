import { app } from 'electron';
import path from 'path';
import fs from 'fs';
import { createGunzip } from 'zlib';
import { fetchWithTimeout } from '../../shared/fetchWithTimeout';
import {
  initCacheDb,
  getMeta,
  setMeta,
  getImdbRatingCount,
  clearAndBulkInsertImdbRatings,
  getImdbRatingsBatch as dbGetImdbRatingsBatch,
} from './cacheDb';
import { withNetworkTracking } from './networkActivity';

// ──────────────────────────────────────────────────────────────────────────
// IMDB dataset client — SQLite-backed ratings lookup via the shared cache DB.
//
// IMDB publishes a daily-refreshed public dataset at:
//   https://datasets.imdbws.com/title.ratings.tsv.gz
//
// Schema (gzipped TSV, UTF-8, ~8.24 MiB compressed, ~1.71M rows):
//   tconst         e.g. "tt0111161"
//   averageRating  e.g. "9.3"        (0.0–10.0)
//   numVotes       e.g. "2900000"
//
// The data is stored in the shared `cache.db` SQLite file (table
// `imdb_ratings`), alongside the IDs cache and ratings cache. See cacheDb.ts.
//
// Architecture:
//   - On startup: open DB (via initCacheDb), check `meta.imdb_dataset_last_update`.
//     If stale (>36h) or empty, kick off a background refresh (does NOT block UI).
//   - Lookups are sync `better-sqlite3` queries — sub-millisecond.
//   - When the background refresh completes, all registered `onRefreshed`
//     callbacks fire — the enricher re-looks-up its movies and emits
//     `rating:updated` IPC events for any that changed or are newly available.
//   - If the refresh fails, we keep using whatever's in the DB. No crash.
//
// The .tsv.gz is downloaded to a temp file, parsed, inserted into SQLite
// in a transaction, then deleted. Only the SQLite DB remains on disk.
// ──────────────────────────────────────────────────────────────────────────

const DATASET_URL = 'https://datasets.imdbws.com/title.ratings.tsv.gz';
const DATASET_TTL_MS = 36 * 60 * 60 * 1000;   // 36 hours
const DOWNLOAD_TIMEOUT_MS = 120_000;            // 2 minutes for ~8 MB download
const META_KEY_LAST_UPDATE = 'imdb_dataset_last_update';

/** Format a timestamp for debug logs: HH:MM:ss.sss */
function ts(): string {
  const d = new Date();
  return d.toLocaleTimeString('en-GB', { hour12: false }) + '.' + String(d.getMilliseconds()).padStart(3, '0');
}


const DEBUG = process.env.ARVE_DEBUG === '1';
function debug(...args: unknown[]) { if (DEBUG) console.log(`[${ts()}] [imdb-dataset]`, ...args); }

interface RatingEntry {
  rating: number;
  votes: number;
}

type RefreshCallback = () => void;
const refreshCallbacks = new Set<RefreshCallback>();
let refreshInProgress = false;

/** Returns the last successful refresh time, or null if never refreshed. */
function getLastUpdate(): Date | null {
  const v = getMeta(META_KEY_LAST_UPDATE);
  if (!v) return null;
  try { return new Date(v); } catch { return null; }
}

/** Record the refresh time in the DB. */
function setLastUpdate(date: Date): void {
  setMeta(META_KEY_LAST_UPDATE, date.toISOString());
}

/** Returns the number of IMDB ratings currently in the DB. */
export function getRatingCount(): number {
  return getImdbRatingCount();
}

/** Returns true if the DB has been populated with at least one rating. */
export function isDatasetLoaded(): boolean {
  return getRatingCount() > 0;
}

/** Returns the age of the dataset in ms, or Infinity if never refreshed. */
export function getDatasetAge(): number {
  const last = getLastUpdate();
  if (!last) return Infinity;
  return Date.now() - last.getTime();
}

/** Register a callback that fires when the dataset is refreshed in the
 *  background. Returns an unsubscribe function. */
export function onDatasetRefreshed(cb: RefreshCallback): () => void {
  refreshCallbacks.add(cb);
  return () => { refreshCallbacks.delete(cb); };
}

function notifyRefreshed(): void {
  for (const cb of refreshCallbacks) {
    try { cb(); } catch (err) {
      console.warn('[imdb-dataset] refresh callback threw:', err);
    }
  }
}

// ── Download + parse ──────────────────────────────────────────────────────

async function downloadDataset(destPath: string): Promise<void> {
  const headers: Record<string, string> = {
    'User-Agent': 'ArveCinema/0.6.0 (https://github.com/SylvainSouche/arvecinema)',
    Accept: 'application/octet-stream, application/x-gzip, */*',
  };

  debug(`downloading ${DATASET_URL} ...`);
  const res = await fetchWithTimeout(DATASET_URL, { headers }, DOWNLOAD_TIMEOUT_MS);

  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText}`);
  }

  const fileStream = fs.createWriteStream(destPath, { mode: 0o644 });
  const reader = res.body?.getReader();
  if (!reader) throw new Error('response body is null');

  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      fileStream.write(value);
      totalBytes += value.length;
    }
  }
  fileStream.end();
  await new Promise<void>((resolve, reject) => {
    fileStream.on('finish', () => resolve());
    fileStream.on('error', reject);
  });
  debug(`downloaded ${totalBytes} bytes`);
}

function parseLine(line: string): [string, number, number] | null {
  if (!line || line.startsWith('tconst\t')) return null;
  const [tconst, avgStr, votesStr] = line.split('\t');
  if (!tconst || !tconst.startsWith('tt')) return null;
  if (avgStr === '\\N' || votesStr === '\\N') return null;
  const rating = Number(avgStr);
  const votes = Number(votesStr);
  if (!Number.isFinite(rating) || !Number.isFinite(votes)) return null;
  if (rating < 0 || rating > 10) return null;
  return [tconst, rating, votes];
}

/** Stream-parse the .tsv.gz and bulk-insert into SQLite in a transaction. */
async function parseAndInsert(filePath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const rows: Array<[string, number, number]> = [];
    let buffer = '';
    let totalParsed = 0;

    const stream = fs.createReadStream(filePath).pipe(createGunzip());

    stream.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf-8');
      let newlineIdx: number;
      while ((newlineIdx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.substring(0, newlineIdx);
        buffer = buffer.substring(newlineIdx + 1);
        const row = parseLine(line);
        if (row) {
          rows.push(row);
          totalParsed++;
        }
      }
    });

    stream.on('end', () => {
      try {
        clearAndBulkInsertImdbRatings(rows);
        debug(`inserted ${totalParsed} ratings into SQLite (table imdb_ratings)`);
        resolve(totalParsed);
      } catch (err) {
        reject(err);
      }
    });

    stream.on('error', (err: Error) => {
      reject(new Error(`parse failed: ${err.message}`));
    });
  });
}

async function refreshDataset(): Promise<void> {
  if (refreshInProgress) {
    debug('refresh already in progress — skipping');
    return;
  }
  refreshInProgress = true;
  const tmpPath = path.join(app.getPath('userData'), 'title.ratings.tsv.gz.tmp');
  try {
    // Wrap the entire download+parse in network tracking so the UI's
    // refresh-icon spinner stays animated throughout.
    await withNetworkTracking(async () => {
      await downloadDataset(tmpPath);
      const count = await parseAndInsert(tmpPath);
      setLastUpdate(new Date());
      debug(`refresh complete — ${count} ratings in DB`);
    });
    notifyRefreshed();
  } catch (err) {
    console.warn(
      `[imdb-dataset] refresh failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    // Always delete the temp .tsv.gz — we don't keep it on disk.
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    refreshInProgress = false;
  }
}

// ── Public API ────────────────────────────────────────────────────────────

/** Initialize the dataset. Ensures the cache DB is open and kicks off a
 *  background refresh if the cached data is stale (>36h old) or missing. */
export function initDataset(): void {
  initCacheDb();

  const age = getDatasetAge();
  const count = getRatingCount();
  debug(
    `init: ${count} ratings cached, last update ${
      Number.isFinite(age) ? Math.round(age / 3600000) + 'h ago' : 'never'
    }`,
  );

  if (age > DATASET_TTL_MS || count === 0) {
    debug(
      `dataset is ${
        Number.isFinite(age) ? Math.round(age / 3600000) + 'h' : '∞'
      } old — refreshing in background`,
    );
    refreshDataset().catch((err) => {
      console.warn('[imdb-dataset] background refresh error:', err);
    });
  }
}

/** Batch lookup: given a list of IMDB title IDs, return a Map keyed by
 *  tconst → {rating, votes}. Sync. Missing IDs are simply omitted. */
export function getRatingsByTconst(tconsts: string[]): Map<string, RatingEntry> {
  return dbGetImdbRatingsBatch(tconsts);
}

/** Force a refresh — download the latest dataset and reload. */
export async function refreshDatasetNow(): Promise<void> {
  await refreshDataset();
}
