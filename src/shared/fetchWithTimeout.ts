// ──────────────────────────────────────────────────────────────────────────
// Network helpers — used by all cinema adapters.
// ──────────────────────────────────────────────────────────────────────────

/**
 * Wrap a `fetch()` call with an AbortController-based timeout.
 *
 * Without this, a slow or unresponsive cinema server can leave the schedule
 * loader hanging indefinitely, with no way for the user to cancel.
 *
 * @param url       target URL
 * @param init      standard fetch options (headers, method, etc.)
 * @param timeoutMs abort after this many milliseconds
 * @throws {TimeoutError} when the timeout fires before the response arrives
 */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new TimeoutError(`request timed out after ${timeoutMs}ms: ${url}`);
    }
    throw err;
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
