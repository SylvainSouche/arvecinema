import './tz';   // MUST be first — sets process.env.TZ before any Date construction (BUG-04)

import { app, BrowserWindow, ipcMain, nativeImage, shell, Menu } from 'electron';
import path from 'path';

import { CINEMAS, CINEMA_INFOS } from './cinemas/registry';
import type { Movie, ScheduleResponse, CinemaStatus } from './cinemas/types';
import { enrichWithRatings } from './ratings/ratingsEnricher';
import { getNetworkActive } from './ratings/networkActivity';

// ── Constants ──────────────────────────────────────────────────────────────

/** How many days from today the schedule fetcher should ask each cinema for. */
const SCHEDULE_WINDOW_DAYS = 14;

/** Window dimensions — chosen to comfortably fit the week grid + sidebar. */
const WINDOW_WIDTH = 1400;
const WINDOW_HEIGHT = 900;

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

ipcMain.handle(
  'schedule:fetch',
  async (_evt, cinemaIds?: string[]): Promise<ScheduleResponse> => {
    const enabled = cinemaIds && cinemaIds.length > 0
      ? CINEMAS.filter(c => cinemaIds.includes(c.id))
      : CINEMAS;

    const t0 = Date.now();

    // Fetch each cinema in parallel and keep its individual status.
    const results = await Promise.all(
      enabled.map(async (c): Promise<{
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
            err instanceof Error && err.name === 'TimeoutError' ? 'timeout' :
            err instanceof Error && err.name === 'ScraperSchemaChangedError' ? 'parse-error' :
            'http-error';
          const message = err instanceof Error ? err.message : String(err);
          console.error(`[cinemas] ${c.id} failed (${reason}):`, message);
          return {
            status: { cinemaId: c.id, status: reason, error: message },
            availableDays: [],
            movies: [],
          };
        }
      }),
    );

    const t1 = Date.now();
    const movieCount = results.reduce((n, r) => n + r.movies.length, 0);
    if (process.env.ARVE_DEBUG === '1') {
      console.log(`[schedule] fetched ${enabled.length} cinemas, ${movieCount} movies in ${t1 - t0}ms`);
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
      .flatMap(r => r.movies)
      .sort((a, b) => {
        const t = a.title.localeCompare(b.title, 'fr', { sensitivity: 'base' });
        return t !== 0 ? t : a.cinemaId.localeCompare(b.cinemaId);
      });

    // Per-cinema status list (rendered in the UI as a warning banner).
    const cinemaStatuses: CinemaStatus[] = results.map(r => r.status);

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
    const moviesWithImdb = movies.filter(m => m.imdbRating !== undefined).length;
    const moviesWithAc = movies.filter(m => m.allocinePress !== undefined || m.allocineAudience !== undefined).length;
    const moviesWithRt = movies.filter(m => m.rtTomatometer !== undefined).length;
    if (process.env.ARVE_DEBUG === '1') {
      console.log(
        `[schedule] Phase 0 cache applied in ${t2 - t1}ms: ` +
        `${moviesWithImdb}/${movies.length} IMDB, ${moviesWithAc}/${movies.length} AC, ${moviesWithRt}/${movies.length} RT ` +
        `(total since fetch start: ${t2 - t0}ms)`,
      );
    }

    return { availableDays, movies, cinemaStatuses };
  },
);

// ── IPC (DEV-ONLY): export ALL movies from ALL cinemas ─────────────────────
//
// Fetches schedules from ALL 4 cinemas (ignoring the UI's cinema selector),
// waits for ratings enrichment to complete, then returns the full movie list.
// Used by the dev-only JSON export button to dump everything — not just the
// currently-displayed (filtered/selected) subset.
//
// Disabled in packaged builds.

ipcMain.handle('dev:export-all', async (): Promise<{ movies: Movie[]; cinemaStatuses: CinemaStatus[] }> => {
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
          err instanceof Error && err.name === 'TimeoutError' ? 'timeout' :
          err instanceof Error && err.name === 'ScraperSchemaChangedError' ? 'parse-error' :
          'http-error';
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[dev:export-all] ${c.id} failed (${reason}):`, message);
        return {
          status: { cinemaId: c.id, status: reason as CinemaStatus['status'], error: message },
          movies: [],
        };
      }
    }),
  );

  const movies = results
    .flatMap(r => r.movies)
    .sort((a, b) => {
      const t = a.title.localeCompare(b.title, 'fr', { sensitivity: 'base' });
      return t !== 0 ? t : a.cinemaId.localeCompare(b.cinemaId);
    });

  const cinemaStatuses = results.map(r => r.status);

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
});

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

// DEV-ONLY: probe the IMDB Top 250 GraphQL endpoint to verify anonymous
// access works. Exposed as IPC so it can be invoked from the renderer's
// DevTools console via `window.arveProbeTop250()`.
ipcMain.handle('dev:probe-top250', async (): Promise<string> => {
  if (app.isPackaged) {
    return 'probe disabled in packaged builds';
  }
  try {
    const { probeTop250 } = await import('./ratings/imdbGraphqlClient');
    return await probeTop250();
  } catch (err) {
    return `probe failed: ${err instanceof Error ? err.message : String(err)}`;
  }
});

ipcMain.handle('tickets:open', async (_evt, url: unknown): Promise<boolean> => {
  if (typeof url !== 'string' || !url) return false;
  try {
    const parsed = new URL(url);
    if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
      console.warn('[tickets:open] rejected non-https URL:', url);
      return false;
    }
    await shell.openExternal(parsed.toString());
    return true;
  } catch (err) {
    console.error('[tickets:open] invalid URL:', url, err);
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
    : path.join(__dirname, '../../build/icon.png');
  try {
    icon = nativeImage.createFromPath(iconPath);
    if (icon.isEmpty()) icon = undefined;
  } catch {
    icon = undefined;
  }

  // macOS dev mode: override the Electron dock icon with ours.
  if (icon && process.platform === 'darwin' && !app.isPackaged) {
    try { app.dock?.setIcon(icon); } catch { /* ignore */ }
  }

  mainWindow = new BrowserWindow({
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
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
    console.warn('[setWindowOpenHandler] blocked renderer-initiated navigation to:', url);
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
    try { allowedOrigins.add(new URL(devUrl).origin); } catch { /* ignore */ }
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
      console.warn('[will-navigate] blocked:', url);
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
      console.warn('[setWindowOpenHandler] blocked in child contents:', url);
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
        console.warn('[will-navigate] blocked in child contents:', url);
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
}

/** Extract the origin from a URL string, returning '' on parse failure. */
function safeOrigin(url: string): string {
  try { return new URL(url).origin; } catch { return ''; }
}

/** Returns true if `url` is on the same registrable domain as `referenceUrl`.
 *  Used to allow WAF/Cloudflare reloads (which navigate to the same domain)
 *  while still blocking cross-origin navigations. */
function isSameRegistrableDomain(referenceUrl: string, url: string): boolean {
  try {
    const refHost = new URL(referenceUrl).hostname;
    const targetHost = new URL(url).hostname;
    return targetHost === refHost ||
      targetHost.endsWith('.' + refHost) ||
      refHost.endsWith('.' + targetHost);
  } catch {
    return false;
  }
}

app.whenReady().then(createWindow);

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

app.on('window-all-closed', () => {
  // Force quit on ALL platforms — the enrichment workers and connection
  // pool keep the event loop alive, so app.quit() alone isn't enough.
  // On macOS we also quit (unlike the typical pattern) because this app
  // has no reason to stay alive without a window.
  //
  // Graceful shutdown: cancel background workers, destroy hidden windows,
  // close SQLite DB, then exit. If cleanup takes too long, the 200ms
  // timeout in gracefulShutdown() force-exits.
  import('./ratings/shutdown').then(({ gracefulShutdown }) => {
    void gracefulShutdown();
  }).catch(() => {
    // Fallback: if the import fails for any reason, just exit immediately.
    app.exit(0);
  });
});

// Also handle before-quit (Cmd+Q on macOS, Alt+F4 on Windows/Linux)
app.on('before-quit', (event) => {
  // Prevent the default quit — we'll handle it ourselves via gracefulShutdown.
  // Only do this once to avoid infinite loop.
  if (!beforeQuitHandled) {
    beforeQuitHandled = true;
    event.preventDefault();
    import('./ratings/shutdown').then(({ gracefulShutdown }) => {
      void gracefulShutdown();
    }).catch(() => {
      app.exit(0);
    });
  }
});

let beforeQuitHandled = false;
