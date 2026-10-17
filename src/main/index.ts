import './tz'; // MUST be first — sets process.env.TZ before any Date construction (BUG-04)

import { app, BrowserWindow, nativeImage, Menu, screen } from 'electron';
import path from 'path';

import { CINEMAS, loadCustomCinemas } from './cinemas/registry';
import { buildAllowedChildDomains, isChildNavigationAllowed } from './navigationPolicy';
import { registerIpcHandlers } from './services/ipcRegistrar';
import { gracefulShutdown } from './ratings/shutdown';
import { maybeInitAutoUpdater } from './updater';
import { initLogging } from './ratings/logger';
import { log } from './ratings/moduleLoggers';

// ──────────────────────────────────────────────────────────────────────────
// index.ts — composition root (ARCH-01).
//
// Everything request-shaped lives in services/:
//   - services/ipcRegistrar.ts      → IPC channels (sender checks + parse
//                                     boundaries) → scheduleService /
//                                     ratingsCoordinator
//   - services/scheduleService.ts   → schedule orchestration (tested)
//   - services/ratingsCoordinator.ts→ ratings-retry orchestration (tested)
//   - services/ratingUpdates.ts     → rating:updated payload (tested)
// Everything viewport-shaped stays in windowSecurity HERE (this file):
//   window creation, navigation policy wiring (navigationPolicy.ts), the
//   child allow-list, permission denial and app lifecycle/shutdown.
// ──────────────────────────────────────────────────────────────────────────

/** Path of the user-editable custom cinema registry (in userData, next to
 *  cache.db). Loaded at startup; re-loadable via `cinemas:reload-custom`. */
function customCinemasFile(): string {
  return path.join(app.getPath('userData'), 'custom-cinemas.json');
}

/** Notify every renderer that the registry changed (custom cinemas loaded/
 *  saved via IPC) so they refetch the cinema list + schedule. */
function notifyCinemasChanged(): void {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send('cinemas:changed');
  }
  // The child-window navigation allow-list is derived from the live cinema
  // registry (custom cinemas add new base URLs) — rebuild it here too.
  rebuildNavigationAllowList();
}

// ── Child-window navigation allow-list (navigationPolicy.ts) ──────────────
// REVIEW-SEC-01: explicit PSL allow-list, rebuilt whenever the cinema
// registry changes (custom cinemas may point at new domains).

let navigationAllowList: ReadonlySet<string> = buildAllowedChildDomains([]);

function rebuildNavigationAllowList(): void {
  const baseUrls: string[] = [];
  for (const c of CINEMAS) {
    const baseUrl = (c.adapter as { config?: { baseUrl?: unknown } }).config?.baseUrl;
    if (typeof baseUrl === 'string' && baseUrl.length > 0) baseUrls.push(baseUrl);
  }
  navigationAllowList = buildAllowedChildDomains(baseUrls);
  log.schedule.debug(
    `[navigation] child-window allow-list rebuilt: ${[...navigationAllowList].join(', ')}`,
  );
}

// ── Constants ──────────────────────────────────────────────────────────────

/** Default window dimensions — comfortable for the week grid + sidebar.
 *  Will be clamped to the screen's work area (see createWindow below). */
const DEFAULT_WINDOW_WIDTH = 1400;
const DEFAULT_WINDOW_HEIGHT = 900;
/** Minimum window size — below this the UI becomes unusable
 *  (filter bar wraps awkwardly, movie cards get too narrow). */
const MIN_WINDOW_WIDTH = 900;
const MIN_WINDOW_HEIGHT = 600;

// ── IPC registration (services/ipcRegistrar.ts) ────────────────────────────
// All renderer-facing channels live there; this passes only the app-lifecycle
// bits the registrar cannot know.
registerIpcHandlers({
  customCinemasFile,
  notifyCinemasChanged,
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
  // EXCEPTION: allow-listed navigations within/between the cinema+provider
  // domains are allowed, because:
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
      // Review SEC-01: explicit allow-list policy (not a hostname suffix
      // heuristic). Applies to WAF/Cloudflare reloads (same registrable
      // domain) and same-app cross-domain hops (e.g. cinema site →
      // allocine.fr inside the ratings browserFetch flow)…
      const decision = isChildNavigationAllowed(contents.getURL(), url, navigationAllowList);
      if (decision.allowed) {
        log.browserFetch.debug(`[will-navigate] child nav allowed: ${decision.reason}`);
        return;
      }
      // …and to the dev origins (only in dev).
      if (allowedOrigins.has(safeOrigin(url))) return;
      event.preventDefault();
      log.schedule.warn(`[will-navigate] blocked in child contents: ${url} (${decision.reason})`);
    });
    // Redirects are a separate navigation boundary — revalidate them too
    // (review SEC-01: "revalidate redirects at every navigation boundary").
    contents.on('will-redirect', (event, url) => {
      if (isAllowedFile(url)) return;
      const decision = isChildNavigationAllowed(contents.getURL(), url, navigationAllowList);
      if (decision.allowed) return;
      if (allowedOrigins.has(safeOrigin(url))) return;
      event.preventDefault();
      log.schedule.warn(`[will-redirect] blocked in child contents: ${url} (${decision.reason})`);
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
    log.shutdown.warn('[main] mainWindow closed event');
    doShutdown('mainWindow-closed');
  });

  // Also catch the close button BEFORE the window is destroyed —
  // this fires when the user clicks the red close button.
  mainWindow.on('close', () => {
    log.shutdown.debug('[main] mainWindow close event');
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

app.whenReady().then(() => {
  initLogging(process.env.ARVE_DEBUG === '1');

  // REVIEW-SEC-01: build the child-window navigation allow-list from the
  // current registry (builtin + custom) before any hidden windows are used.
  rebuildNavigationAllowList();

  // Register user-authored custom cinemas (userData/custom-cinemas.json)
  // before any window exists — the renderer's first cinemas:list call then
  // already includes them. Never throws; failures are logged.
  loadCustomCinemas(customCinemasFile());

  createWindow();

  // Auto-update checker (electron-updater, GitHub Releases feed). No-op in
  // dev and in ARVE_REPLAY/ARVE_RECORD fixture runs — all guards inside.
  maybeInitAutoUpdater();
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
// Driver for the graceful shutdown coordinator (src/main/ratings/shutdown.ts):
//   1. Signal background workers to stop (cancellation flag)
//   2. Destroy all BrowserWindows (kills hidden browserFetch windows)
//   3. Close SQLite DB (flushes WAL)
//   4. Flush logs
//   5. Save the replayable network fixture (ARVE_RECORD mode)
//   6. process.exit(0) — immediate, no waiting for in-flight HTTP

let isShuttingDown = false;

function doShutdown(reason: string): void {
  if (isShuttingDown) return;
  isShuttingDown = true;

  try {
    gracefulShutdown();
  } catch (err) {
    // Exit path: the flush may already have failed — stderr is the last
    // channel that still works. Allowed by the console audit via marker.
    console.error(`[shutdown] ${reason} — graceful path failed: ${err}`); // logging:exit-path
  }
  // gracefulShutdown ends in process.exit(0); if it somehow returned, force.
  process.exit(0);
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
  console.error(`[main] process PID: ${process.pid}`); // logging:exit-path (debug diagnostics go to stderr only)

  process.on('SIGUSR2', () => {
    console.error('\n=== SIGUSR2 — dumping state ==='); // logging:exit-path
    console.error(`PID: ${process.pid}`); // logging:exit-path
    console.error(`isShuttingDown: ${isShuttingDown}`); // logging:exit-path
    console.error(`\n=== Stack ===\n${new Error().stack}`); // logging:exit-path

    try {
      // @ts-ignore
      const handles = process._getActiveHandles?.() ?? [];
      console.error(`\n=== Active handles: ${handles.length} ===`); // logging:exit-path
      for (const h of handles) {
        const name = h.constructor?.name ?? 'unknown';
        const detail = name === 'Socket' ? ` ${(h as any).remoteAddress ?? ''}:${(h as any).remotePort ?? ''} destroyed=${(h as any).destroyed}` :
                       name === 'WriteStream' ? ` path=${(h as any).path ?? ''}` :
                       name === 'Server' ? ` connections=${(h as any)._connections ?? 0}` :
                       '';
        console.error(`  ${name}${detail}`); // logging:exit-path
      }
      // @ts-ignore
      const requests = process._getActiveRequests?.() ?? [];
      console.error(`\n=== Active requests: ${requests.length} ===`); // logging:exit-path
      for (const r of requests) {
        console.error(`  ${r.constructor?.name ?? 'unknown'}`); // logging:exit-path
      }
    } catch (e) {
      console.error(`dump failed: ${e}`); // logging:exit-path
    }

    console.error('\n=== End dump ===\n'); // logging:exit-path
  });
}

// Catch uncaught errors that might prevent shutdown
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err); // logging:exit-path (logger state may be the crash cause)
  doShutdown('uncaughtException');
});
