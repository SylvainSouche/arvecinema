import { BrowserWindow } from 'electron';

// ──────────────────────────────────────────────────────────────────────────
// Shutdown coordinator — ensures all background work is stopped and all
// resources are released before the app process exits.
//
// Problem: when the user closes the app window, `app.quit()` fires but
// the process doesn't exit because:
//   1. Enrichment workers (Phase 1 Wikidata + Phase 2 AC/RT) have in-flight
//      promises that keep the Node.js event loop alive.
//   2. Hidden browserFetch BrowserWindows may still be loading pages.
//   3. The SQLite DB connection (better-sqlite3) is never explicitly closed.
//   4. The IMDB dataset download may be in progress.
//
// Solution: a cancellation token that all background workers check, plus
// explicit cleanup of all resources. If cleanup doesn't complete within
// 3 seconds, we force-exit.
// ──────────────────────────────────────────────────────────────────────────

let cancelled = false;

/** Returns true if shutdown has been requested. Background workers should
 *  check this periodically and abort their work if true. */
export function isCancelled(): boolean {
  return cancelled;
}

/** Request cancellation of all background work. Idempotent. */
export function requestCancellation(): void {
  cancelled = true;
}

/** Perform graceful shutdown — SYNCHRONOUS, no awaits.
 *
 * Every step is wrapped in try/catch so one failure doesn't block the
 * next. The function ends with process.exit(0) which kills the process
 * immediately — no waiting for in-flight HTTP requests, no waiting for
 * Electron cleanup hooks.
 *
 * Call from `app.on('window-all-closed')` or `app.on('before-quit')`. */
export function gracefulShutdown(): void {
  // Step 1: signal all background workers to stop.
  requestCancellation();

  // Step 2: destroy ALL BrowserWindows (main + hidden browserFetch windows).
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      try { win.destroy(); } catch { /* ignore */ }
    }
  }

  // Step 3: close the SQLite DB connection (synchronous — better-sqlite3).
  try {
    // Use require() not import() — these modules are already loaded,
    // and require() is synchronous so we don't risk hanging on a
    // never-resolving promise.
    const { closeCacheDb } = require('./cacheDb');
    closeCacheDb();
  } catch { /* DB not open or already closed */ }

  // Step 4: flush log dispatchers (synchronous).
  try {
    const { flushLogs } = require('./logger');
    flushLogs();
  } catch { /* logger not initialized */ }

  // Step 5: save recorded network fixture (if ARVE_RECORD was set).
  try {
    const { saveRecordedFixture } = require('./networkRecorder');
    saveRecordedFixture();
  } catch { /* recorder not loaded */ }

  // Step 6: FORCE EXIT — don't wait for in-flight HTTP requests,
  // enrichment workers, or Electron cleanup. The cancellation flag
  // (Step 1) tells workers to stop, but they may be stuck on a
  // fetchWithTimeout/browserFetch call that won't resolve for up to
  // 20 seconds. We don't wait — just kill the process.
  process.exit(0);
}
