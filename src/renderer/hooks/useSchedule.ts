import { useState, useEffect, useCallback } from 'react';
import type { Movie, CinemaInfo, CinemaStatus } from '../../shared/types';
import { fetchCinemas, fetchSchedule } from '../api/cinemaApi';
import { todayIso } from '../../shared/cinema';

// ──────────────────────────────────────────────────────────────────────────
// useSchedule — fetches the cinema list + schedule.
//
// Manages: movies, availableDays, cinemaStatuses, cinemas, loading, error,
// lastUpdated, and the reload callback (triggered by cinema selection
// changes or the manual refresh button).
//
// Uses a cancellation flag + useCallback so React StrictMode's double-mount
// in dev doesn't race two concurrent fetches.
// ──────────────────────────────────────────────────────────────────────────

export function useSchedule(selectedCinemaIds: string[]): {
  movies: Movie[];
  setMovies: React.Dispatch<React.SetStateAction<Movie[]>>;
  availableDays: string[];
  cinemas: CinemaInfo[];
  cinemaStatuses: CinemaStatus[];
  loading: boolean;
  error: string | null;
  lastUpdated: Date | null;
  reload: () => void;
} {
  const [movies, setMovies] = useState<Movie[]>([]);
  const [availableDays, setAvailableDays] = useState<string[]>([]);
  const [cinemas, setCinemas] = useState<CinemaInfo[]>([]);
  const [cinemaStatuses, setCinemaStatuses] = useState<CinemaStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  // Load cinema list (one-shot)
  useEffect(() => {
    fetchCinemas()
      .then(setCinemas)
      .catch(() => {
        /* non-fatal: the UI just hides the cinema selector */
      });
  }, []);

  const reload = useCallback(() => {
    let cancelled = false;
    setLoading(true);
    const ids = selectedCinemaIds.length === 0 ? undefined : selectedCinemaIds;
    fetchSchedule(ids)
      .then(({ movies, availableDays, cinemaStatuses }) => {
        if (cancelled) return;
        setMovies(movies);
        setAvailableDays(availableDays);
        setCinemaStatuses(cinemaStatuses);
        setLastUpdated(new Date());
        // Pick a sensible default day if the current selection is no longer valid.
        const today = todayIso();
        // (Day selection is handled by the caller via the returned availableDays)
        void today;
        setError(null);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedCinemaIds]);

  useEffect(() => reload(), [reload]);

  return {
    movies,
    setMovies,
    availableDays,
    cinemas,
    cinemaStatuses,
    loading,
    error,
    lastUpdated,
    reload,
  };
}
