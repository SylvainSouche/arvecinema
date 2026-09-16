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
});
