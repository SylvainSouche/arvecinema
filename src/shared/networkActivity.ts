import { BrowserWindow } from 'electron';

// ──────────────────────────────────────────────────────────────────────────
// Network activity tracker — notifies the renderer when network activity
// is in progress (browserFetch, pooledFetch, dataset download, etc.).
//
// The renderer uses this to:
//   - Spin the refresh icon when network activity is in flight
//   - Show "loading" state in the header
//
// We use a simple counter: any in-flight request bumps it, completion
// decrements it. When the counter goes from 0 → 1, we send `active: true`.
// When it goes from 1 → 0, we send `active: false`. Intermediate changes
// don't fire IPC events (would be too noisy).
// ──────────────────────────────────────────────────────────────────────────

let inflightCount = 0;
let lastActiveState = false;

/** Bump the in-flight counter. Call when a network operation starts. */
export function trackNetworkStart(): void {
  inflightCount++;
  if (!lastActiveState) {
    lastActiveState = true;
    broadcastActivity(true);
  }
}

/** Decrement the in-flight counter. Call when a network operation ends
 *  (success or failure). */
export function trackNetworkEnd(): void {
  inflightCount = Math.max(0, inflightCount - 1);
  if (inflightCount === 0 && lastActiveState) {
    lastActiveState = false;
    broadcastActivity(false);
  }
}

/** Returns true if there are any in-flight network operations. */
export function getNetworkActive(): boolean {
  return inflightCount > 0;
}

/** Wrap a Promise-returning function with network activity tracking.
 *
 *  Note: trackNetworkStart/End may throw if BrowserWindow isn't ready yet
 *  (e.g. on the very first network call during app startup). We catch those
 *  errors silently — network tracking is a UI nicety, not critical to the
 *  fetch itself. The actual fetch (fn) always runs and its result/error
 *  is always propagated. */
export async function withNetworkTracking<T>(fn: () => Promise<T>): Promise<T> {
  try { trackNetworkStart(); } catch { /* BrowserWindow not ready — ignore */ }
  try {
    return await fn();
  } finally {
    try { trackNetworkEnd(); } catch { /* ignore */ }
  }
}

function broadcastActivity(active: boolean): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('network:activity', active);
  }
}
