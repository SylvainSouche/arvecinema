import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  fetchCinemas: () => ipcRenderer.invoke('cinemas:list'),
  fetchSchedule: (cinemaIds?: string[]) => ipcRenderer.invoke('schedule:fetch', cinemaIds),

  /** Open an external URL via the validated main-process path. */
  openTicket: (url: string) => ipcRenderer.invoke('tickets:open', url),

  /** Listen for progressive rating updates. The callback receives
   *  { cinemaId, movieId, ratings } for each movie as it's enriched.
   *  Returns an unsubscribe function. */
  onRatingUpdated: (
    callback: (data: {
      cinemaId: string;
      movieId: string;
      ratings: Record<string, unknown>;
    }) => void,
  ) => {
    const handler = (_event: unknown, data: unknown) => callback(data as never);
    ipcRenderer.on('rating:updated', handler);
    return () => ipcRenderer.removeListener('rating:updated', handler);
  },

  /** Listen for enrichment progress updates. The callback receives
   *  { resolved, total, pct } — fires whenever a film finishes processing
   *  (either scraped or cache-hit). When resolved === total, enrichment
   *  is complete and the UI should hide the progress bar. */
  onRatingsProgress: (
    callback: (data: { resolved: number; total: number; pct: number }) => void,
  ) => {
    const handler = (_event: unknown, data: unknown) => callback(data as never);
    ipcRenderer.on('ratings:progress', handler);
    return () => ipcRenderer.removeListener('ratings:progress', handler);
  },

  /** Listen for network activity state. The callback receives `true` when
   *  any network operation starts (browserFetch, pooledFetch, dataset
   *  download, schedule fetch, Wikidata SPARQL) and `false` when all
   *  in-flight operations complete. Used to animate the refresh icon. */
  onNetworkActivity: (callback: (active: boolean) => void) => {
    // Query current state immediately — handles the race where network
    // activity started before the renderer subscribed.
    ipcRenderer
      .invoke('dev:get-network-state')
      .then((state: unknown) => {
        callback(state as boolean);
      })
      .catch(() => {
        /* ignore */
      });
    const handler = (_event: unknown, data: unknown) => callback(data as never);
    ipcRenderer.on('network:activity', handler);
    return () => ipcRenderer.removeListener('network:activity', handler);
  },

  /** DEV-ONLY: fetch ALL movies from ALL 4 cinemas (ignoring the UI's cinema
   *  selector), trigger ratings enrichment, and return the full movie list.
   *  Used by the JSON export button to dump everything. Disabled in packaged
   *  builds. Returns { movies, cinemaStatuses }. */
  exportAll: () => ipcRenderer.invoke('dev:export-all'),

  /** Retry failed rating lookups. Pass the current movie list (with their
   *  wikidataUrl + current rating statuses). Main process will re-fetch
   *  only the sources currently in 'blocked' status. Updates flow back
   *  via `onRatingUpdated` — no need to handle the return value, but it's
   *  useful for showing a "X recovered / Y still failing" toast.
   *  Returns { retried, succeeded, stillFailing }. */
  retryFailedLookups: (
    movies: Array<{
      cinemaId: string;
      id: string;
      title: string;
      wikidataUrl?: string;
      imdbStatus?: string;
      allocineStatus?: string;
      rtStatus?: string;
    }>,
  ) =>
    ipcRenderer.invoke('ratings:retry', movies) as Promise<{
      retried: number;
      succeeded: number;
      stillFailing: number;
    }>,

  /** Get all captured log entries from the main process. */
  getLogs: () => ipcRenderer.invoke('log:get-all'),

  /** Clear the log buffer in the main process. */
  clearLogs: () => ipcRenderer.invoke('log:clear'),

  /** Subscribe to real-time log entries from the main process.
   *  Each entry has { timestamp, level, component, message } where
   *  level is 'debug' | 'info' | 'warn' | 'error'.
   *  Returns an unsubscribe function. */
  onLogAppend: (
    callback: (entry: {
      timestamp: string;
      level: 'debug' | 'info' | 'warn' | 'error';
      component: string;
      message: string;
    }) => void,
  ) => {
    const handler = (_event: unknown, data: unknown) => callback(data as never);
    ipcRenderer.on('log:append', handler);
    return () => ipcRenderer.removeListener('log:append', handler);
  },
});
