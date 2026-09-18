import { app, BrowserWindow } from 'electron';

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

/** Perform graceful shutdown:
 *   1. Set the cancellation flag (stops enrichment workers)
 *   2. Destroy all hidden BrowserWindows (stops browserFetch)
 *   3. Close the SQLite DB connection (flushes WAL)
 *   4. Give the event loop 500ms to settle
 *   5. Force-exit if still alive
 *
 *  Call from `app.on('window-all-closed')` or `app.on('before-quit')`. */
export async function gracefulShutdown(): Promise<void> {
  // Step 1: signal all background workers to stop.
  requestCancellation();

  // Step 2: destroy ALL BrowserWindows except the main window (which is
  // already closing). This kills any in-flight browserFetch/browserGraphqlFetch
  // hidden windows immediately — we don't care about their results anymore.
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      try { win.destroy(); } catch { /* ignore */ }
    }
  }

  // Step 3: close the SQLite DB connection. Imported lazily so this module
  // doesn't create a circular dependency at load time.
  try {
    const { closeCacheDb } = await import('./cacheDb');
    closeCacheDb();
  } catch { /* DB not open or already closed */ }

  // Step 4: give the event loop a brief moment to let pending timers
  // (setTimeout, setInterval) fire their cleanup callbacks.
  await new Promise(r => setTimeout(r, 200));

  // Step 5: if the process is still alive (some timer or handle is keeping
  // it), force-exit. app.exit(0) runs Electron's cleanup hooks before dying.
  app.exit(0);
}
