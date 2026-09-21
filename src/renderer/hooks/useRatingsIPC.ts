import { useState, useEffect } from 'react';
import type { Movie } from '../../shared/types';

// ──────────────────────────────────────────────────────────────────────────
// useRatingsIPC — subscribes to the 3 main-process IPC channels related
// to ratings enrichment:
//   - `rating:updated`     → patches a single movie's ratings in state
//   - `ratings:progress`   → { resolved, total, pct } for the progress bar
//   - `network:activity`    → boolean for the refresh-icon spinner
//
// All three are subscribed once at mount; unsubscribed on unmount.
// ──────────────────────────────────────────────────────────────────────────

export interface RatingsProgress {
  resolved: number;
  total: number;
  pct: number;
}

export function useRatingsIPC(setMovies: React.Dispatch<React.SetStateAction<Movie[]>>): {
  progress: RatingsProgress;
  networkActive: boolean;
} {
  const [progress, setProgress] = useState<RatingsProgress>({
    resolved: 0,
    total: 0,
    pct: 0,
  });
  const [networkActive, setNetworkActive] = useState(false);

  // Progressive ratings: listen for per-movie rating updates
  useEffect(() => {
    const unsubscribe = window.electronAPI.onRatingUpdated((data) => {
      setMovies((prev) =>
        prev.map((m) => {
          if (m.cinemaId !== data.cinemaId || m.id !== data.movieId) return m;
          return { ...m, ...data.ratings } as typeof m;
        }),
      );
    });
    return unsubscribe;
  }, [setMovies]);

  // Subscribe to enrichment progress + network activity IPC events
  useEffect(() => {
    const unsubProgress = window.electronAPI.onRatingsProgress((data) => {
      setProgress(data);
    });
    const unsubNetwork = window.electronAPI.onNetworkActivity((active) => {
      setNetworkActive(active);
    });
    return () => {
      unsubProgress();
      unsubNetwork();
    };
  }, []);

  return { progress, networkActive };
}
