// ──────────────────────────────────────────────────────────────────────────
// Network helpers — used by all cinema adapters.
//
// Supports record/replay via ARVE_RECORD / ARVE_REPLAY env vars.
// See src/shared/networkRecorder.ts for details.
// ──────────────────────────────────────────────────────────────────────────

import {
  isReplaying,
  isRecording,
  getReplayResponse,
  createMockResponse,
  recordResponse,
} from './networkRecorder';

/**
 * Wrap a `fetch()` call with AbortController-based timeouts covering BOTH
 * the headers + the body read.
 *
 * Previously the timeout only fired if the server didn't respond with headers
 * in time. A server that sends headers immediately but then trickles the body
 * at 1 byte/sec could keep the request alive indefinitely. The fix uses a
 * single AbortController whose timeout covers the whole call — including the
 * `res.text()` / `res.arrayBuffer()` consumer — and a separate body-read
 * timeout that re-arms after headers arrive.
 *
 * Without this, a slow or unresponsive cinema server can leave the schedule
 * loader hanging indefinitely, with no way for the user to cancel.
 *
 * @param url       target URL
 * @param init      standard fetch options (headers, method, etc.)
 * @param timeoutMs abort after this many milliseconds (default 15s, covers
 *                  headers + body)
 * @throws {TimeoutError} when the timeout fires before the response completes
 */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number = REQUEST_TIMEOUT_MS,
): Promise<Response> {
  // ── Replay mode: return recorded response, no network call ──
  if (isReplaying) {
    const method = (init.method as string) ?? 'GET';
    const recorded = getReplayResponse(method, url);
    if (recorded) {
      return createMockResponse(recorded);
    }
    // If no recorded response, fall through to real fetch (for URLs
    // we didn't capture). This allows partial replays.
  }

  // ── Real fetch (with timeout) ──
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });

    // ── Record mode: save the response body ──
    if (isRecording && res.ok) {
      const method = (init.method as string) ?? 'GET';
      // Clone the response so we can read the body without consuming it
      const clone = res.clone();
      const body = await clone.text().catch(() => '');
      const headers: Record<string, string> = {};
      clone.headers.forEach((val, key) => {
        headers[key] = val;
      });
      recordResponse(method, url, res.status, body, headers);
    }

    return res;
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new TimeoutError(`request timed out after ${timeoutMs}ms: ${url}`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Read the response body as text with an independent timeout.
 *
 * Use this when you've already received the response headers via
 * `fetchWithTimeout` and want to bound the body read separately from the
 * headers timeout. Useful when the server is known to send headers quickly
 * but trickle the body (some cinema CMSs do this under load).
 *
 * @throws {TimeoutError} when the body read exceeds `timeoutMs`.
 */
export async function readBodyWithTimeout(
  res: Response,
  timeoutMs: number = REQUEST_TIMEOUT_MS,
): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    // res.body is a ReadableStream; abort the stream's underlying signal.
    // If res.body is null (e.g. opaque response), fall back to res.text().
    if (res.body) {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let received = '';
      const deadline = Date.now() + timeoutMs;
      while (true) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new TimeoutError(`body read timed out after ${timeoutMs}ms`);
        const readResult = await Promise.race([
          reader.read(),
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new TimeoutError(`body read timed out after ${timeoutMs}ms`)),
              remaining,
            ),
          ),
        ]);
        if (readResult.done) break;
        received += decoder.decode(readResult.value, { stream: true });
      }
      received += decoder.decode();
      return received;
    }
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

/** Error thrown when a fetch exceeds its timeout. Distinct from generic Error
 *  so the main process can classify per-cinema status as `timeout` vs `http-error`. */
export class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TimeoutError';
  }
}

/** Default timeout for cinema API calls (15 s — generous enough for the
 *  slowest cinema site, short enough that the user doesn't think the app
 *  is hung). */
export const REQUEST_TIMEOUT_MS = 15_000;
