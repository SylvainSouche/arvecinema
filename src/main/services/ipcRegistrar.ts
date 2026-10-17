import { app, BrowserWindow, ipcMain, shell } from 'electron';
import { CINEMAS, getCinemaInfos, loadCustomCinemas } from '../cinemas/registry';
import { readCustomCinemasFile, saveCustomCinemas } from '../cinemas/customCinemasIpc';
import { listPlugins } from '../cinemas/adapters';
import type { Movie, ScheduleResponse, CinemaStatus } from '../cinemas/types';
import { enrichWithRatings } from '../ratings/ratingsEnricher';
import { getNetworkActive } from '../../shared/networkActivity';
import { getAllLogs, clearLogs } from '../ratings/logger';
import { log } from '../ratings/moduleLoggers';
import {
  parseCinemaIdsInput,
  parseRetryMoviesInput,
  defaultSanitizeString,
} from '../security/ipcValidation';
import { movieToRatingUpdate, type RatingUpdateMessage } from './ratingUpdates';
import { fetchSchedules, type EnabledCinema } from './scheduleService';
import { retryBlockedLookups } from './ratingsCoordinator';
import { createRefreshSequence } from '../../shared/refreshToken';

// ──────────────────────────────────────────────────────────────────────────
// ipcRegistrar — the single place that maps renderer IPC channels to main
// services (ARCH-01 extraction). index.ts composes the injected deps
// (paths that depend on the app lifecycle) and calls registerIpcHandlers
// once at load.
//
// Separation of concerns along the request path:
//   renderer message → [registrar: sender check + parse/sanitize] →
//   [service: orchestration] → [broadcast seam: electron]. Application
//   logic never touches the event object.
//
// Refresh generations: every schedule refresh (schedule:fetch, and the
// dev-only export) opens a new generation; a superseded run's enrichment
// broadcasts are suppressed through the isStale closure handed to the
// enricher (ratingsEnricher honors it) AND the service relays.
// ──────────────────────────────────────────────────────────────────────────

/** How many days from today each cinema is asked for (schedule window). */
const SCHEDULE_WINDOW_DAYS = 14;

/** Allowed protocols for ticketing URLs opened via `shell.openExternal`. */
const ALLOWED_PROTOCOLS = new Set(['https:']);

/** Refresh-generation sequence: a schedule:fetch starts a new generation;
 *  enrichment broadcasts from superseded runs are suppressed. */
const refreshSeq = createRefreshSequence();

/** Grep-proofed sender check: accept privileged operations only from
 *  webContents this app actually created (the main renderer, log viewer
 *  windows, devtools…). Anything else (e.g. a webview injected later) is
 *  rejected. */
export function isKnownRendererSender(
  evt: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent,
): boolean {
  return BrowserWindow.getAllWindows().some((w) => w.webContents === evt.sender);
}

/** Broadcast one `rating:updated` message to every renderer window. */
function broadcastRatingUpdate(message: RatingUpdateMessage): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('rating:updated', message);
  }
}

/** Movie seam used by the schedule service: map + broadcast. */
function publishMovieRating(movie: Movie): void {
  broadcastRatingUpdate(movieToRatingUpdate(movie));
}

export interface IpcRegistrarDeps {
  /** Path of the custom-cinemas file (app-getPath-dependent — injected). */
  customCinemasFile: () => string;
  /** Tell every renderer the registry changed (refetch + allow-list). */
  notifyCinemasChanged: () => void;
}

/** Describe the registered cinemas as EnabledCinema seams for the service. */
function enabledCinemas(list: typeof CINEMAS): EnabledCinema[] {
  return list.map((c) => ({ id: c.id, fetch: (days: number) => c.adapter.fetchSchedule(days) }));
}

/**
 * Register all renderer-facing IPC handlers. Called once from index.ts at
 * module load — same ordering guarantees as before the extraction.
 */
export function registerIpcHandlers(deps: IpcRegistrarDeps): void {
  // ── IPC: list available cinemas (metadata only — no adapter leak) ──

  ipcMain.handle('cinemas:list', () => getCinemaInfos());

  // ── IPC: custom-cinemas settings UI support (thin over the file module) ──

  ipcMain.handle('cinemas:read-custom', () => readCustomCinemasFile(deps.customCinemasFile()));

  ipcMain.handle('cinemas:save-custom', (_evt, entries: unknown) => {
    const result = saveCustomCinemas(deps.customCinemasFile(), entries);
    deps.notifyCinemasChanged();
    return result;
  });

  /** Adapter kinds available for the form's select. Metadata only. */
  ipcMain.handle('cinemas:plugin-kinds', () => listPlugins());

  /** Re-read the file from disk and re-register (manual JSON editors). */
  ipcMain.handle('cinemas:reload-custom', () => {
    const result = loadCustomCinemas(deps.customCinemasFile());
    deps.notifyCinemasChanged();
    return result;
  });

  // ── IPC: session schedule refresh ────────────────────────────────────────
  ipcMain.handle('schedule:fetch', async (evt, cinemaIds?: unknown): Promise<ScheduleResponse> => {
    // Validation boundary (IPC-01): malformed payload = rejected whole
    // request, never a shrug-and-continue into application logic.
    if (!isKnownRendererSender(evt)) {
      log.schedule.warn('[schedule:fetch] rejected unknown sender webContents');
      throw new Error('schedule:fetch: unexpected sender');
    }
    const cinemaIdParse = parseCinemaIdsInput(cinemaIds);
    if (!cinemaIdParse.ok) {
      log.schedule.warn(`[schedule:fetch] rejected: ${cinemaIdParse.reason}`);
      throw new Error(`schedule:fetch: ${cinemaIdParse.reason}`);
    }
    const enabled =
      cinemaIdParse.value.length > 0
        ? enabledCinemas(CINEMAS.filter((c) => cinemaIdParse.value.includes(c.id)))
        : enabledCinemas(CINEMAS);

    const t0 = Date.now();

    // New refresh generation — from here on, any still-running older
    // schedule:fetch's enrichment broadcasts are considered stale.
    const gen = refreshSeq.next();

    // Enrichment continues in the background; the Phase 0-cached ratings
    // are already applied in place by the time the response below is
    // returned.
    const response = await fetchSchedules(
      {
        fetchScheduleOf: (c, days) => c.fetch(days),
        enrich: (movies, onUpdated, opts) => enrichWithRatings(movies, onUpdated, opts),
        publishRatingUpdate: publishMovieRating,
        logError: (cinemaId, reason, message) =>
          log.schedule.error(`[cinemas] ${cinemaId} failed (${reason}): ${message}`),
      },
      { enabled, days: SCHEDULE_WINDOW_DAYS, isStale: () => !refreshSeq.isCurrent(gen) },
    );

    if (process.env.ARVE_DEBUG === '1') {
      const t1 = Date.now();
      const movieCount = response.movies.length;
      log.schedule.info(`[schedule] fetched ${enabled.length} cinemas, ${movieCount} movies in ${t1 - t0}ms`);
    }

    return response;
  });

  // ── IPC (DEV-ONLY): export ALL movies from ALL cinemas ──────────────────
  //
  // Fetches schedules from ALL cinemas (ignoring the UI selector), waits
  // for ratings enrichment to complete, then returns everything. Not part
  // of the shipped surface (disabled in packaged builds).
  ipcMain.handle(
    'dev:export-all',
    async (): Promise<{ movies: Movie[]; cinemaStatuses: CinemaStatus[] }> => {
      if (app.isPackaged) {
        return { movies: [], cinemaStatuses: [] };
      }

      const gen = refreshSeq.next(); // supersede any running UI refresh

      const response = await fetchSchedules(
        {
          fetchScheduleOf: (c, days) => c.fetch(days),
          enrich: (movies, onUpdated, opts) => enrichWithRatings(movies, onUpdated, opts),
          publishRatingUpdate: publishMovieRating,
          logError: (cinemaId, reason, message) =>
            log.schedule.error(`[dev:export-all] ${cinemaId} failed (${reason}): ${message}`),
        },
        {
          enabled: enabledCinemas(CINEMAS),
          days: SCHEDULE_WINDOW_DAYS,
          isStale: () => !refreshSeq.isCurrent(gen),
          awaitEnrichment: true,
        },
      );

      return { movies: response.movies, cinemaStatuses: response.cinemaStatuses };
    },
  );

  // ── IPC: retry failed rating lookups (CMB-012) ───────────────────────────
  //
  // The renderer sends its currently displayed movies (wikidataUrl + current
  // rating statuses); the main process re-fetches ONLY blocked sources,
  // ignoring the freshness TTL. Updates stream back over `rating:updated`.
  ipcMain.handle(
    'ratings:retry',
    async (
      evt,
      moviesFromRenderer: unknown,
    ): Promise<{ retried: number; succeeded: number; stillFailing: number }> => {
      // Validation boundary (IPC-01): rendered payload is untrusted typed
      // data. Parse + sanitize (whitelist fields, caps, id patterns,
      // known-cinema ids). The RETRY ITSELF reads the real identifiers from
      // the server-side ids_cache (by QID), so a forged payload cannot
      // smuggle fake ids into any fetch.
      if (!isKnownRendererSender(evt)) {
        log.enricher.warn('[ratings:retry] rejected unknown sender webContents');
        return { retried: 0, succeeded: 0, stillFailing: 0 };
      }
      const parsed = parseRetryMoviesInput(
        moviesFromRenderer,
        new Set(CINEMAS.map((c) => c.id)),
        defaultSanitizeString,
      );
      if (!parsed.ok) {
        log.enricher.warn(`[ratings:retry] rejected: ${parsed.reason}`);
        return { retried: 0, succeeded: 0, stillFailing: 0 };
      }

      // Lazy-load the fetcher module to avoid pulling it into the main
      // bundle at startup.
      const { retryFailedLookups } = await import('../ratings/ratingsFetcher');

      log.enricher.info(`[ratings:retry] received ${parsed.value.length} valid movies from renderer`);

      return retryBlockedLookups(parsed.value, {
        publish: broadcastRatingUpdate,
        retry: retryFailedLookups,
      });
    },
  );

  // ── IPC: open a ticketing URL in the user's default browser (CMB-008) ────
  //
  // Ticketing URLs come from remote cinema data and are validated to HTTPS;
  // shell.openExternal keeps navigation outside the sandboxed renderer.
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

  // ── IPC: network activity state (late-subscribing renderers) ─────────────
  ipcMain.handle('dev:get-network-state', () => {
    return getNetworkActive();
  });

  // ── IPC: log management ─────────────────────────────────────────────────────
  ipcMain.handle('log:get-all', () => {
    return getAllLogs();
  });

  ipcMain.handle('log:clear', () => {
    clearLogs();
    return true;
  });
}
