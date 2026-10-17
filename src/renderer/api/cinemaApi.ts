import type { CinemaInfo, ScheduleResponse } from '../types';

export const fetchCinemas = (): Promise<CinemaInfo[]> =>
  window.electronAPI.fetchCinemas();

export const fetchSchedule = (cinemaIds?: string[]): Promise<ScheduleResponse> =>
  window.electronAPI.fetchSchedule(cinemaIds);

// ── Custom cinemas settings (About panel → Cinemas tab) ───────────────────

/** Raw entries of `userData/custom-cinemas.json` for the editor form. */
export const readCustomCinemas = (): Promise<{ path: string; exists: boolean; cinemas: unknown[] }> =>
  window.electronAPI.readCustomCinemas();

/** Persist the editor's list + re-register in the main process. */
export const saveCustomCinemas = (
  entries: unknown[],
): Promise<{
  written: boolean;
  reload: { registered: string[]; errors: Array<{ entry: string; message: string }> };
}> => window.electronAPI.saveCustomCinemas(entries);

/** Adapter kinds registered in the main process (for the form's select). */
export const listPluginKinds = (): Promise<
  Array<{ id: string; displayName: string; description?: string }>
> => window.electronAPI.listPluginKinds();

/** Subscribe to registry changes from custom-cinema save/reload. Returns an
 *  unsubscribe function. */
export const onCinemasChanged = (callback: () => void): (() => void) =>
  window.electronAPI.onCinemasChanged(callback);

/** Open an external HTTPS URL via the validated main-process path.
 *  Used by the About panel to open GitHub / IMDB / etc. links in the
 *  user's default browser. Validates HTTPS-only — non-HTTPS URLs are
 *  rejected by the main process's `tickets:open` handler. */
export const openTicket = (url: string): Promise<boolean> =>
  window.electronAPI.openTicket(url);
