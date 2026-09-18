import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  fetchCinemas: () => ipcRenderer.invoke('cinemas:list'),
  fetchSchedule: (cinemaIds?: string[]) => ipcRenderer.invoke('schedule:fetch', cinemaIds),

  /** Open an external URL via the validated main-process path. */
  openTicket: (url: string) => ipcRenderer.invoke('tickets:open', url),

  /** Listen for progressive rating updates. The callback receives
   *  { cinemaId, movieId, ratings } for each movie as it's enriched.
   *  Returns an unsubscribe function. */
  onRatingUpdated: (callback: (data: {
    cinemaId: string;
    movieId: string;
    ratings: Record<string, unknown>;
  }) => void) => {
    const handler = (_event: unknown, data: unknown) => callback(data as never);
    ipcRenderer.on('rating:updated', handler);
    return () => ipcRenderer.removeListener('rating:updated', handler);
  },

  /** Listen for enrichment progress updates. The callback receives
   *  { resolved, total, pct } — fires whenever a film finishes processing
   *  (either scraped or cache-hit). When resolved === total, enrichment
   *  is complete and the UI should hide the progress bar. */
  onRatingsProgress: (callback: (data: {
    resolved: number;
    total: number;
    pct: number;
  }) => void) => {
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
    ipcRenderer.invoke('dev:get-network-state').then((state: unknown) => {
      callback(state as boolean);
    }).catch(() => { /* ignore */ });
    const handler = (_event: unknown, data: unknown) => callback(data as never);
    ipcRenderer.on('network:activity', handler);
    return () => ipcRenderer.removeListener('network:activity', handler);
  },

  /** DEV-ONLY: probe the IMDB Top 250 GraphQL endpoint to verify anonymous
   *  access via `caching.graphql.imdb.com`. Returns the raw response body
   *  (or an error message). Disabled in packaged builds. */
  probeTop250: () => ipcRenderer.invoke('dev:probe-top250'),

  /** DEV-ONLY: fetch ALL movies from ALL 4 cinemas (ignoring the UI's cinema
   *  selector), trigger ratings enrichment, and return the full movie list.
   *  Used by the JSON export button to dump everything. Disabled in packaged
   *  builds. Returns { movies, cinemaStatuses }. */
  exportAll: () => ipcRenderer.invoke('dev:export-all'),
});
