import './tz';   // MUST be first — sets process.env.TZ before any Date construction (BUG-04)

import { app, BrowserWindow, ipcMain, nativeImage, shell, Menu } from 'electron';
import path from 'path';

import { CINEMAS, CINEMA_INFOS } from './cinemas/registry';
import type { Movie, ScheduleResponse, CinemaStatus } from './cinemas/types';
import { enrichWithRatings } from './ratings/ratingsEnricher';

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
          // CMB-007: classify timeout vs HTTP error vs scraper schema change
          // so the renderer can show the right message.
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

    return { availableDays, movies, cinemaStatuses };
  },
);

// ── IPC: open a ticketing URL in the user's default browser ─────────────────
//
// CMB-008: ticketing URLs come from remote cinema data and must be validated
// before opening. We allow only HTTPS URLs to prevent `javascript:` or other
// unexpected protocols. The URL is opened via `shell.openExternal` rather than
// a renderer `<a target="_blank">` to keep navigation outside the sandboxed
// renderer.

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
  const allowedOrigins = new Set<string>();
  if (devUrl) {
    try { allowedOrigins.add(new URL(devUrl).origin); } catch { /* ignore */ }
  }
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const isLocalFile = url.startsWith('file://');
    const isAllowedDev = allowedOrigins.has(safeOrigin(url));
    if (!isLocalFile && !isAllowedDev) {
      event.preventDefault();
      console.warn('[will-navigate] blocked:', url);
    }
  });

  // SEC-03: deny all permission requests (geolocation, notifications, media
  // capture, etc.). This app needs none of them, so deny by default.
  mainWindow.webContents.session.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  mainWindow.webContents.session.setPermissionCheckHandler(() => false);

  // Apply the same handlers to any future webContents (webviews, child windows).
  app.on('web-contents-created', (_event, contents) => {
    contents.setWindowOpenHandler(({ url }) => {
      console.warn('[setWindowOpenHandler] blocked in child contents:', url);
      return { action: 'deny' };
    });
    contents.on('will-navigate', (event, url) => {
      const isLocalFile = url.startsWith('file://');
      const isAllowedDev = allowedOrigins.has(safeOrigin(url));
      if (!isLocalFile && !isAllowedDev) {
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
  app.quit();
  process.exit(0);
});
