// ──────────────────────────────────────────────────────────────────────────
// Network recorder/replayer — captures ALL HTTP traffic for deterministic
// E2E tests.
//
// Two modes:
//
//   ARVE_RECORD=path/to/fixtures.json
//     Wraps fetchWithTimeout + browserFetch to record every request +
//     response to a JSON file. The app runs normally against real servers.
//
//   ARVE_REPLAY=path/to/fixtures.json
//     Wraps fetchWithTimeout + browserFetch to return recorded responses
//     instead of making real network calls. No internet needed. Fully
//     deterministic.
//
// Fixture format:
//   {
//     "GET:https://www.wikidata.org/w/api.php?action=query&...": {
//       "status": 200,
//       "statusText": "OK",
//       "headers": { "content-type": "application/json" },
//       "body": "..."
//     },
//     "GET:https://www.allocine.fr/film/fichefilm_gen_cfilm=276608.html": {
//       "status": 200,
//       "body": "<html>..."
//     }
//   }
//
// The key is `${method}:${url}` — if the same URL is fetched multiple times
// (e.g. cache miss + refresh), the LAST recorded response wins.
// ──────────────────────────────────────────────────────────────────────────

import fs from 'node:fs';
import path from 'node:path';
import { simpleLog as log } from './simpleLogger';

const RECORD_PATH = process.env.ARVE_RECORD;
const REPLAY_PATH = process.env.ARVE_REPLAY;

export const isRecording = Boolean(RECORD_PATH);
export const isReplaying = Boolean(REPLAY_PATH);

// ── Fixture store ──────────────────────────────────────────────────────────

interface RecordedResponse {
  status: number;
  statusText?: string;
  headers?: Record<string, string>;
  body: string;
}

type FixtureMap = Map<string, RecordedResponse>;

let recordStore: FixtureMap = new Map();
let replayStore: FixtureMap | null = null;

/** Load the replay fixture file (if in replay mode). */
function loadReplayFixture(): FixtureMap | null {
  if (!REPLAY_PATH) return null;
  try {
    const raw = fs.readFileSync(REPLAY_PATH, 'utf-8');
    const data = JSON.parse(raw) as Record<string, RecordedResponse>;
    return new Map(Object.entries(data));
  } catch (err) {
    log.warn('[network-recorder] failed to load replay fixture: ' + (err instanceof Error ? err.message : String(err)));
    return null;
  }
}

// Lazy-load the replay store on first access
function getReplayStore(): FixtureMap | null {
  if (replayStore === null && REPLAY_PATH) {
    replayStore = loadReplayFixture();
    if (replayStore) {
      const count = replayStore.size;
      log.info(
        `[network-recorder] replay mode: loaded ${count} recorded responses from ${REPLAY_PATH}`,
      );
    }
  }
  return replayStore;
}

/** Save the recorded fixture to disk (called on app shutdown). */
export function saveRecordedFixture(): void {
  if (!RECORD_PATH || recordStore.size === 0) return;

  // Resolve relative to project root
  const outPath = path.resolve(process.cwd(), RECORD_PATH);

  // Convert Map → object
  const obj: Record<string, RecordedResponse> = {};
  for (const [key, val] of recordStore) {
    obj[key] = val;
  }

  try {
    fs.writeFileSync(outPath, JSON.stringify(obj, null, 2));
    log.info(
      `[network-recorder] saved ${recordStore.size} recorded responses to ${outPath}`,
    );
  } catch (err) {
    log.warn(
      '[network-recorder] failed to save fixture: ' + (err instanceof Error ? err.message : String(err)),
    );
  }
}

// ── Key generation ──────────────────────────────────────────────────────────

function makeKey(method: string, url: string): string {
  // Normalize: strip query params that change per-request (e.g. timestamps)
  // Keep the URL as-is for now — if we need normalization, add it here.
  return `${method}:${url}`;
}

// ── Record wrapper ──────────────────────────────────────────────────────────

/** Record a response. Called after the real fetch/browserFetch completes. */
export function recordResponse(
  method: string,
  url: string,
  status: number,
  body: string,
  headers?: Record<string, string>,
): void {
  if (!RECORD_PATH) return;
  const key = makeKey(method, url);
  recordStore.set(key, {
    status,
    statusText: status >= 200 && status < 300 ? 'OK' : undefined,
    headers: headers
      ? Object.fromEntries(
          Object.entries(headers).filter(
            ([k]) =>
              !k.startsWith(':') && // strip HTTP/2 pseudo-headers
              k.toLowerCase() !== 'set-cookie' && // cookies are per-request
              k.toLowerCase() !== 'date' &&
              k.toLowerCase() !== 'etag' &&
              k.toLowerCase() !== 'last-modified' &&
              k.toLowerCase() !== 'expires' &&
              k.toLowerCase() !== 'cache-control',
          ),
        )
      : undefined,
    body,
  });
}

// ── Replay wrapper ──────────────────────────────────────────────────────────

/** Look up a recorded response. Returns null if not found. */
export function getReplayResponse(method: string, url: string): RecordedResponse | null {
  if (!isReplaying) return null;
  const store = getReplayStore();
  if (!store) return null;

  // Try exact match first
  const key = makeKey(method, url);
  const exact = store.get(key);
  if (exact) return exact;

  // Try URL without trailing slash, or with trailing slash
  const altUrl = url.endsWith('/') ? url.slice(0, -1) : url + '/';
  const altKey = makeKey(method, altUrl);
  const alt = store.get(altKey);
  if (alt) return alt;

  // Try matching by URL path only (ignoring query params that may differ)
  // This is useful for Wikidata API calls where query params contain
  // the search string (which is the same) but URL-encoding may differ.
  try {
    const urlObj = new URL(url);
    const baseKey = `${method}:${urlObj.origin}${urlObj.pathname}`;
    for (const [k, v] of store) {
      if (k.startsWith(baseKey)) return v;
    }
  } catch {
    // URL parsing failed — skip fuzzy matching
  }

  return null;
}

/** Create a fake Response object that mimics a real fetch() Response. */
export function createMockResponse(recorded: RecordedResponse): Response {
  const headers = new Headers(recorded.headers ?? { 'content-type': 'text/html' });
  return new Response(recorded.body, {
    status: recorded.status,
    statusText: recorded.statusText ?? '',
    headers,
  });
}
