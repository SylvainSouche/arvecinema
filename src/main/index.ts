import './tz'; // MUST be first — sets process.env.TZ before any Date construction (BUG-04)

import { app, BrowserWindow, ipcMain, nativeImage, shell, Menu, screen } from 'electron';
import path from 'path';

import { CINEMAS, CINEMA_INFOS } from './cinemas/registry';
import type { Movie, ScheduleResponse, CinemaStatus } from './cinemas/types';
import { enrichWithRatings } from './ratings/ratingsEnricher';
import { getNetworkActive } from './ratings/networkActivity';
import { initLogging, getAllLogs, clearLogs } from './ratings/logger';
import { log } from './ratings/moduleLoggers';

// ── Constants ──────────────────────────────────────────────────────────────

/** How many days from today the schedule fetcher should ask each cinema for. */
const SCHEDULE_WINDOW_DAYS = 14;

/** Default window dimensions — comfortable for the week grid + sidebar.
 *  Will be clamped to the screen's work area (see createWindow below). */
const DEFAULT_WINDOW_WIDTH = 1400;
const DEFAULT_WINDOW_HEIGHT = 900;
/** Minimum window size — below this the UI becomes unusable
 *  (filter bar wraps awkwardly, movie cards get too narrow). */
const MIN_WINDOW_WIDTH = 900;
const MIN_WINDOW_HEIGHT = 600;

/** Allowed protocols for ticketing URLs opened via `shell.openExternal`. */
const ALLOWED_PROTOCOLS = new Set(['https:']);

// ── IPC: list available cinemas (metadata only — no adapter function leak) ──

ipcMain.handle('cinemas:list', () => CINEMA_INFOS);

// ── IPC: fetch schedule for a subset of cinemas (default: all) ──────────────
//
// CMB-005: we now track per-cinema status so the renderer can distinguish
// "no screenings this week" from "cinema server unreachable". Without this
// distinction the UI would silently present an empty cinema as if it had
// nothing scheduled.

ipcMain.handle('schedule:fetch', async (_evt, cinemaIds?: string[]): Promise<ScheduleResponse> => {
  const enabled =
    cinemaIds && cinemaIds.length > 0 ? CINEMAS.filter((c) => cinemaIds.includes(c.id)) : CINEMAS;

  const t0 = Date.now();

  // Fetch each cinema in parallel and keep its individual status.
  const results = await Promise.all(
    enabled.map(
      async (
        c,
      ): Promise<{
        status: CinemaStatus;
        availableDays: string[];
        movies: Movie[];
      }> => {
        try {
          const r = await c.adapter.fetchSchedule(SCHEDULE_WINDOW_DAYS);
          return {
            status: { cinemaId: c.id, status: 'ok' },
            availableDays: r.availableDays,
            movies: r.movies,
          };
        } catch (err) {
          const reason =
            err instanceof Error && err.name === 'TimeoutError'
              ? 'timeout'
              : err instanceof Error && err.name === 'ScraperSchemaChangedError'
                ? 'parse-error'
                : 'http-error';
          const message = err instanceof Error ? err.message : String(err);
          log.schedule.error(`[cinemas] ${c.id} failed (${reason}): ${message}`);
          return {
            status: { cinemaId: c.id, status: reason, error: message },
            availableDays: [],
            movies: [],
          };
        }
      },
    ),
  );

  const t1 = Date.now();
  const movieCount = results.reduce((n, r) => n + r.movies.length, 0);
  if (process.env.ARVE_DEBUG === '1') {
    log.schedule.info(
      `[schedule] fetched ${enabled.length} cinemas, ${movieCount} movies in ${t1 - t0}ms`,
    );
  }

  // Union of available days (sorted, deduplicated).
  const daySet = new Set<string>();
  for (const r of results) for (const d of r.availableDays) daySet.add(d);
  const availableDays = [...daySet].sort();

  // Concatenate all movies — keep one Movie entry per (cinema, film) so each
  // cinema's showtimes are clearly grouped under their own card.
  //
  // UX-03: previously concatenated per-cinema in registry order, producing
  // three alphabetised runs back to back. Now sort globally by title, with
  // cinemaId as the tiebreaker so the same film at two cinemas appears
  // adjacent.
  const movies = results
    .flatMap((r) => r.movies)
    .sort((a, b) => {
      const t = a.title.localeCompare(b.title, 'fr', { sensitivity: 'base' });
      return t !== 0 ? t : a.cinemaId.localeCompare(b.cinemaId);
    });

  // Per-cinema status list (rendered in the UI as a warning banner).
  const cinemaStatuses: CinemaStatus[] = results.map((r) => r.status);

  // Progressive ratings: return movies immediately WITHOUT ratings,
  // then enrich in the background. As each movie is enriched, a
  // `rating:updated` IPC event is sent to the renderer so the UI
  // updates progressively.
  enrichWithRatings(movies, (movie) => {
    // Send the updated movie to all renderer windows.
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('rating:updated', {
        cinemaId: movie.cinemaId,
        movieId: movie.id,
        ratings: {
          imdbId: movie.imdbId,
          imdbRating: movie.imdbRating,
          imdbVotes: movie.imdbVotes,
          imdbUrl: movie.imdbUrl,
          imdbStatus: movie.imdbStatus,
          imdbStatusMessage: movie.imdbStatusMessage,
          allocinePress: movie.allocinePress,
          allocineAudience: movie.allocineAudience,
          allocineVotes: movie.allocineVotes,
          allocineUrl: movie.allocineUrl,
          allocineStatus: movie.allocineStatus,
          allocineStatusMessage: movie.allocineStatusMessage,
          rtTomatometer: movie.rtTomatometer,
          rtCertifiedFresh: movie.rtCertifiedFresh,
          rtUrl: movie.rtUrl,
          rtStatus: movie.rtStatus,
          rtStatusMessage: movie.rtStatusMessage,
          wikidataUrl: movie.wikidataUrl,
        },
      });
    }
  });

  // enrichWithRatings runs Phase 0 synchronously (cached ratings applied
  // to movie objects in-place) before returning. So by the time we
  // reach this line, any cached ratings are already on the movie objects
  // that we're about to return to the renderer.
  const t2 = Date.now();
  const moviesWithImdb = movies.filter((m) => m.imdbRating !== undefined).length;
  const moviesWithAc = movies.filter(
    (m) => m.allocinePress !== undefined || m.allocineAudience !== undefined,
  ).length;
  const moviesWithRt = movies.filter((m) => m.rtTomatometer !== undefined).length;
  if (process.env.ARVE_DEBUG === '1') {
    log.schedule.info(
      `[schedule] Phase 0 cache applied in ${t2 - t1}ms: ` +
        `${moviesWithImdb}/${movies.length} IMDB, ${moviesWithAc}/${movies.length} AC, ${moviesWithRt}/${movies.length} RT ` +
        `(total since fetch start: ${t2 - t0}ms)`,
    );
  }

  return { availableDays, movies, cinemaStatuses };
});

// ── IPC (DEV-ONLY): export ALL movies from ALL cinemas ─────────────────────
//
// Fetches schedules from ALL 4 cinemas (ignoring the UI's cinema selector),
// waits for ratings enrichment to complete, then returns the full movie list.
// Used by the dev-only JSON export button to dump everything — not just the
// currently-displayed (filtered/selected) subset.
//
// Disabled in packaged builds.

ipcMain.handle(
  'dev:export-all',
  async (): Promise<{ movies: Movie[]; cinemaStatuses: CinemaStatus[] }> => {
    if (app.isPackaged) {
      return { movies: [], cinemaStatuses: [] };
    }

    // Fetch ALL cinemas (ignore selection).
    const results = await Promise.all(
      CINEMAS.map(async (c) => {
        try {
          const r = await c.adapter.fetchSchedule(SCHEDULE_WINDOW_DAYS);
          return { status: { cinemaId: c.id, status: 'ok' as const }, movies: r.movies };
        } catch (err) {
          const reason =
            err instanceof Error && err.name === 'TimeoutError'
              ? 'timeout'
              : err instanceof Error && err.name === 'ScraperSchemaChangedError'
                ? 'parse-error'
                : 'http-error';
          const message = err instanceof Error ? err.message : String(err);
          log.schedule.error(`[dev:export-all] ${c.id} failed (${reason}): ${message}`);
          return {
            status: { cinemaId: c.id, status: reason as CinemaStatus['status'], error: message },
            movies: [],
          };
        }
      }),
    );

    const movies = results
      .flatMap((r) => r.movies)
      .sort((a, b) => {
        const t = a.title.localeCompare(b.title, 'fr', { sensitivity: 'base' });
        return t !== 0 ? t : a.cinemaId.localeCompare(b.cinemaId);
      });

    const cinemaStatuses = results.map((r) => r.status);

    // Enrich with ratings (same callback as the normal schedule:fetch path).
    // Unlike the normal path, we AWAIT enrichment to complete before returning
    // — the export button should show the full ratings, not partial results.
    await enrichWithRatings(movies, (movie) => {
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send('rating:updated', {
          cinemaId: movie.cinemaId,
          movieId: movie.id,
          ratings: {
            imdbId: movie.imdbId,
            imdbRating: movie.imdbRating,
            imdbVotes: movie.imdbVotes,
            imdbUrl: movie.imdbUrl,
            imdbStatus: movie.imdbStatus,
            imdbStatusMessage: movie.imdbStatusMessage,
            allocinePress: movie.allocinePress,
            allocineAudience: movie.allocineAudience,
            allocineVotes: movie.allocineVotes,
            allocineUrl: movie.allocineUrl,
            allocineStatus: movie.allocineStatus,
            allocineStatusMessage: movie.allocineStatusMessage,
            rtTomatometer: movie.rtTomatometer,
            rtCertifiedFresh: movie.rtCertifiedFresh,
            rtUrl: movie.rtUrl,
            rtStatus: movie.rtStatus,
            rtStatusMessage: movie.rtStatusMessage,
            wikidataUrl: movie.wikidataUrl,
          },
        });
      }
    });

    return { movies, cinemaStatuses };
  },
);

// ── IPC: retry failed rating lookups ────────────────────────────────────────
//
// CMB-012: when the user clicks the "Retry failed lookups" button in the UI,
// the renderer sends the list of movies currently displayed (with their
// wikidataUrl + current rating statuses). The main process scans this list
// for movies with `status === 'blocked'` and re-fetches ONLY those sources
// (IMDB dataset, AlloCiné, RT), ignoring the freshness TTL.
//
// As each source's fetch completes, a `rating:updated` IPC event is sent to
// all renderer windows — the same path used by the normal enrichment pipeline.
// The renderer doesn't need to track the retry result; it just sees rating
// updates flow in.

ipcMain.handle(
  'ratings:retry',
  async (
    _evt,
    moviesFromRenderer: unknown,
  ): Promise<{ retried: number; succeeded: number; stillFailing: number }> => {
    if (!Array.isArray(moviesFromRenderer)) {
      return { retried: 0, succeeded: 0, stillFailing: 0 };
    }

    // Lazy-load the retry function to avoid pulling the whole fetcher module
    // into the main bundle at startup.
    const { retryFailedLookups } = await import('./ratings/ratingsFetcher');

    log.enricher.info(`[ratings:retry] received ${moviesFromRenderer.length} movies from renderer`);

    return retryFailedLookups(
      moviesFromRenderer as Movie[],
      (movie) => {
        // Same callback shape as the normal enrichment path — patches the
        // movie's ratings in the renderer state.
        for (const win of BrowserWindow.getAllWindows()) {
          win.webContents.send('rating:updated', {
            cinemaId: movie.cinemaId,
            movieId: movie.id,
            ratings: {
              imdbId: movie.imdbId,
              imdbRating: movie.imdbRating,
              imdbVotes: movie.imdbVotes,
              imdbUrl: movie.imdbUrl,
              imdbStatus: movie.imdbStatus,
              imdbStatusMessage: movie.imdbStatusMessage,
              allocinePress: movie.allocinePress,
              allocineAudience: movie.allocineAudience,
              allocineVotes: movie.allocineVotes,
              allocineUrl: movie.allocineUrl,
              allocineStatus: movie.allocineStatus,
              allocineStatusMessage: movie.allocineStatusMessage,
              rtTomatometer: movie.rtTomatometer,
              rtCertifiedFresh: movie.rtCertifiedFresh,
              rtUrl: movie.rtUrl,
              rtStatus: movie.rtStatus,
              rtStatusMessage: movie.rtStatusMessage,
              wikidataUrl: movie.wikidataUrl,
            },
          });
        }
      },
      () => {
        // Progress callback — currently no-op. The renderer's ProgressBar
        // is wired to the `ratings:progress` channel; if we want retries to
        // show progress, we'd broadcast here. For now the count of blocked
        // badges on screen decreases as each retry succeeds, which is
        // already a good progress signal.
      },
    );
  },
);

// ── IPC: open a ticketing URL in the user's default browser ─────────────────
//
// CMB-008: ticketing URLs come from remote cinema data and must be validated
// before opening. We allow only HTTPS URLs to prevent `javascript:` or other
// unexpected protocols. The URL is opened via `shell.openExternal` rather than
// a renderer `<a target="_blank">` to keep navigation outside the sandboxed
// renderer.

// Return current network activity state (for late-subscribing renderers)
ipcMain.handle('dev:get-network-state', () => {
  return getNetworkActive();
});

// ── Log management IPC ───────────────────────────────────────────────────
ipcMain.handle('log:get-all', () => {
  return getAllLogs();
});

ipcMain.handle('log:clear', () => {
  clearLogs();
  return true;
});


ipcMain.handle('tickets:open', async (_evt, url: unknown): Promise<boolean> => {
  if (typeof url !== 'string' || !url) return false;
  try {
    const parsed = new URL(url);
    if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
      log.schedule.warn(`[tickets:open] rejected non-https URL: ${url}`);
      return false;
    }
    await shell.openExternal(parsed.toString());
    return true;
  } catch (err) {
    log.schedule.error(
      `[tickets:open] invalid URL: ${url} ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
});

// ── Window lifecycle ───────────────────────────────────────────────────────

let mainWindow: BrowserWindow | null = null;

function createWindow() {
  // Load the app icon.
  //   - Linux / Windows: sets the window taskbar icon via BrowserWindow({ icon }).
  //   - macOS: the Dock icon comes from the .icns bundled at packaging time,
  //     but in DEV mode the bundle doesn't exist, so we also call
  //     app.dock.setIcon() below to override the default Electron logo.
  let icon: Electron.NativeImage | undefined;
  const iconPath = app.isPackaged
    ? path.join(process.resourcesPath, 'icon.png')
    : path.join(__dirname, '../../build/icon-64.png');
  try {
    icon = nativeImage.createFromPath(iconPath);
    if (icon.isEmpty()) icon = undefined;
  } catch {
    icon = undefined;
  }

  // macOS dev mode: override the Electron dock icon with ours.
  if (icon && process.platform === 'darwin' && !app.isPackaged) {
    try {
      app.dock?.setIcon(icon);
    } catch {
      /* ignore */
    }
  }

  // Compute initial window size — clamp to the primary screen's work area
  // so the window always fits (e.g. on a 13" laptop with 1280×800 display,
  // we'd shrink to fit rather than overflowing the screen).
  const primaryDisplay = screen.getPrimaryDisplay();
  const workArea = primaryDisplay.workArea;
  const initialWidth = Math.min(DEFAULT_WINDOW_WIDTH, workArea.width - 40);
  const initialHeight = Math.min(DEFAULT_WINDOW_HEIGHT, workArea.height - 40);

  mainWindow = new BrowserWindow({
    width: initialWidth,
    height: initialHeight,
    minWidth: MIN_WINDOW_WIDTH,
    minHeight: MIN_WINDOW_HEIGHT,
    // PLAT-01: `titleBarStyle: 'hiddenInset'` is macOS-only. On Windows and
    // Linux it degrades to 'hidden', which removes the native title bar with
    // nothing replacing it — no min/max/close buttons. Use `titleBarOverlay`
    // on those platforms so the OS draws native controls over our header.
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hiddenInset' as const }
      : {
          titleBarStyle: 'hidden' as const,
          titleBarOverlay: { color: '#0a0a0a', symbolColor: '#ffffff', height: 40 },
        }),
    ...(icon ? { icon } : {}),
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
    },
  });

  // CMB-009: deny ALL renderer-initiated window creation. The renderer must
  // not be able to spawn new Electron windows (a potential vector for
  // sandbox escape if combined with a future CSP relaxation). External links
  // are opened via the `tickets:open` IPC handler instead.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    log.schedule.warn(`[setWindowOpenHandler] blocked renderer-initiated navigation to: ${url}`);
    return { action: 'deny' };
  });

  // electron-vite injects the dev server URL into ELECTRON_RENDERER_URL at
  // dev time. In packaged builds it's undefined and we load the built file.
  const devUrl = process.env.ELECTRON_RENDERER_URL || process.env.VITE_DEV_SERVER_URL;

  // SEC-03: block in-place navigation to remote origins. Without this, a
  // renderer induced to run `location.href = 'https://evil.example'` would
  // navigate the main window off your local content, and that remote page
  // then inherits a BrowserWindow with your preload attached.
  //
  // In packaged builds, only the built renderer index.html is a valid
  // file:// target. In dev, the vite dev server origin is allowed.
  const allowedOrigins = new Set<string>();
  if (devUrl) {
    try {
      allowedOrigins.add(new URL(devUrl).origin);
    } catch {
      /* ignore */
    }
  }
  const allowedFileUrl = path.join(__dirname, '../renderer/index.html');
  const isAllowedFile = (url: string): boolean => {
    if (!url.startsWith('file://')) return false;
    try {
      // Decode file:// URL to a filesystem path for comparison.
      const u = new URL(url);
      // On Windows, pathname starts with /C:/... — strip leading slash before drive letter.
      const fsPath = decodeURIComponent(u.pathname).replace(/^\/(?=[A-Za-z]:\/)/, '');
      return path.resolve(fsPath) === path.resolve(allowedFileUrl);
    } catch {
      return false;
    }
  };
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (isAllowedFile(url)) return;
    const isAllowedDev = allowedOrigins.has(safeOrigin(url));
    if (!isAllowedDev) {
      event.preventDefault();
      log.schedule.warn(`[will-navigate] blocked: ${url}`);
    }
  });

  // SEC-03: deny all permission requests (geolocation, notifications, media
  // capture, etc.). This app needs none of them, so deny by default.
  mainWindow.webContents.session.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  mainWindow.webContents.session.setPermissionCheckHandler(() => false);

  // Apply the same handlers to any future webContents (webviews, child windows,
  // AND hidden browserFetch/browserGraphqlFetch windows).
  //
  // EXCEPTION: same-registrable-domain navigations are allowed, because:
  //   - The AWS WAF challenge.js (loaded by imdb.com) calls
  //     window.location.reload(true) to apply the freshly-minted
  //     aws-waf-token cookie. Without this exception, that reload is
  //     blocked, the cookie never lands, and subsequent api.graphql.imdb.com
  //     requests fail with HTTP 415.
  //   - Cloudflare's cf-challenge page does the same thing on allocine.fr.
  app.on('web-contents-created', (_event, contents) => {
    contents.setWindowOpenHandler(({ url }) => {
      log.schedule.warn(`[setWindowOpenHandler] blocked in child contents: ${url}`);
      return { action: 'deny' };
    });
    contents.on('will-navigate', (event, url) => {
      if (isAllowedFile(url)) return;
      // Allow same-registrable-domain navigations (WAF/Cloudflare reloads).
      const currentUrl = contents.getURL();
      if (currentUrl && isSameRegistrableDomain(currentUrl, url)) return;
      const isAllowedDev = allowedOrigins.has(safeOrigin(url));
      if (!isAllowedDev) {
        event.preventDefault();
        log.schedule.warn(`[will-navigate] blocked in child contents: ${url}`);
      }
    });
  });

  if (devUrl) {
    void mainWindow.loadURL(devUrl);
  } else {
    void mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  }

  // Debug mode: open DevTools automatically.
  if (process.env.ARVE_DEBUG === '1') {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }

  // DIRECT close handler — catches the window close button even if
  // window-all-closed doesn't fire (which can happen on macOS when
  // the app has hidden BrowserWindows from the browserFetch pool).
  mainWindow.on('closed', () => {
    console.error('[main] mainWindow closed event');
    doShutdown('mainWindow-closed');
  });

  // Also catch the close button BEFORE the window is destroyed —
  // this fires when the user clicks the red close button.
  mainWindow.on('close', () => {
    console.error('[main] mainWindow close event');
  });
}

/** Extract the origin from a URL string, returning '' on parse failure. */
function safeOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}

/** Returns true if `url` is on the same registrable domain as `referenceUrl`.
 *  Used to allow WAF/Cloudflare reloads (which navigate to the same domain)
 *  while still blocking cross-origin navigations. */
function isSameRegistrableDomain(referenceUrl: string, url: string): boolean {
  try {
    const refHost = new URL(referenceUrl).hostname;
    const targetHost = new URL(url).hostname;
    return (
      targetHost === refHost ||
      targetHost.endsWith('.' + refHost) ||
      refHost.endsWith('.' + targetHost)
    );
  } catch {
    return false;
  }
}

app.whenReady().then(() => {
  initLogging(process.env.ARVE_DEBUG === '1');
  createWindow();
});

// LOW-06: prevent multiple instances of the app. If a second instance is
// launched (e.g. user double-clicks the icon again), focus the existing
// window instead of opening a new one.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const wins = BrowserWindow.getAllWindows();
    if (wins.length > 0) {
      const win = wins[0];
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
}

// LOW-07: trim the default menu in packaged builds so DevTools isn't
// exposed to end users. In dev we keep the full menu for debugging.
if (app.isPackaged) {
  Menu.setApplicationMenu(null);
}

// macOS: re-create a window when the dock icon is clicked and no windows are open.
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// ── Shutdown ────────────────────────────────────────────────────────────────
//
// On macOS, closing the last window fires `window-all-closed`. On all
// platforms, Cmd+Q / Alt+F4 fires `before-quit`.
//
// We handle BOTH with the same simple logic:
//   1. Signal background workers to stop (cancellation flag)
//   2. Destroy all BrowserWindows (kills hidden browserFetch windows)
//   3. Close SQLite DB (flushes WAL)
//   4. process.exit(0) — immediate, no waiting for in-flight HTTP

let isShuttingDown = false;

function doShutdown(reason: string): void {
  if (isShuttingDown) return;
  isShuttingDown = true;

  // Absolute bare minimum: just kill the process.
  // No require(), no cleanup, no diagnostics — those can all throw
  // or hang. The OS will reclaim resources (file handles, sockets,
  // SQLite WAL) when the process dies.
  console.error(`[shutdown] ${reason} — killing process ${process.pid}`);
  process.kill(process.pid, 'SIGKILL');
}

app.on('window-all-closed', () => {
  doShutdown('window-all-closed');
});

app.on('before-quit', (event) => {
  if (!isShuttingDown) {
    event.preventDefault();
    doShutdown('before-quit');
  }
});

// ── Signal handlers for debugging (ARVE_DEBUG only) ──────────────────────────
//
// SIGUSR2 → print full call stack of the event loop to stderr.
//
// Usage when the app won't exit:
//   1. Launch with ARVE_DEBUG=1 to see the PID
//   2. In another terminal: `kill -SIGUSR2 <pid>`
//   3. Check stderr for the stack trace + active handles
//   4. To force kill: `kill -9 <pid>`

if (process.env.ARVE_DEBUG === '1') {
  console.error(`[main] process PID: ${process.pid}`);

  process.on('SIGUSR2', () => {
    console.error('\n=== SIGUSR2 — dumping state ===');
    console.error(`PID: ${process.pid}`);
    console.error(`isShuttingDown: ${isShuttingDown}`);
    console.error(`\n=== Stack ===\n${new Error().stack}`);

    try {
      // @ts-ignore
      const handles = process._getActiveHandles?.() ?? [];
      console.error(`\n=== Active handles: ${handles.length} ===`);
      for (const h of handles) {
        const name = h.constructor?.name ?? 'unknown';
        const detail = name === 'Socket' ? ` ${(h as any).remoteAddress ?? ''}:${(h as any).remotePort ?? ''} destroyed=${(h as any).destroyed}` :
                       name === 'WriteStream' ? ` path=${(h as any).path ?? ''}` :
                       name === 'Server' ? ` connections=${(h as any)._connections ?? 0}` :
                       '';
        console.error(`  ${name}${detail}`);
      }
      // @ts-ignore
      const requests = process._getActiveRequests?.() ?? [];
      console.error(`\n=== Active requests: ${requests.length} ===`);
      for (const r of requests) {
        console.error(`  ${r.constructor?.name ?? 'unknown'}`);
      }
    } catch (e) {
      console.error(`dump failed: ${e}`);
    }

    console.error('\n=== End dump ===\n');
  });
}

// Catch uncaught errors that might prevent shutdown
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
  doShutdown('uncaughtException');
});
