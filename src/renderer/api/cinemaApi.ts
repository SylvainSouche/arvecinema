import type { CinemaInfo, ScheduleResponse } from '../types';

export const fetchCinemas = (): Promise<CinemaInfo[]> =>
  window.electronAPI.fetchCinemas();

export const fetchSchedule = (cinemaIds?: string[]): Promise<ScheduleResponse> =>
  window.electronAPI.fetchSchedule(cinemaIds);

/** Open an external HTTPS URL via the validated main-process path.
 *  Used by the About panel to open GitHub / IMDB / etc. links in the
 *  user's default browser. Validates HTTPS-only — non-HTTPS URLs are
 *  rejected by the main process's `tickets:open` handler. */
export const openTicket = (url: string): Promise<boolean> =>
  window.electronAPI.openTicket(url);
