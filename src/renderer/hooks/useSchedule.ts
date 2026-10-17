import { useState, useEffect, useCallback, useRef } from 'react';
import type { Movie, CinemaInfo, CinemaStatus } from '../../shared/types';
import { fetchCinemas, fetchSchedule, onCinemasChanged } from '../api/cinemaApi';
import { todayIso } from '../../shared/cinema';
import { createRefreshSequence } from '../../shared/refreshToken';

// ──────────────────────────────────────────────────────────────────────────
// useSchedule — fetches the cinema list + schedule.
//
// Manages: movies, availableDays, cinemaStatuses, cinemas, loading, error,
// lastUpdated, and the reload callback (triggered by cinema selection
// changes or the manual refresh button).
//
// Refresh-generation guard (review race fix): reload() can be triggered
// concurrently — selection change, manual ↻, cinemas:changed — and the
// older trigger's cleanup is NOT always run (onCinemasChanged and the
// manual refresh call reload() directly, bypassing the effect's cleanup).
// So the cancellation flag alone is not enough: every response must be
// checked against the token sequence, and a late OLDER response is
// discarded instead of overwriting the latest schedule.
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

  // Refresh generations: useRef keeps ONE sequence for this hook instance's
  // lifetime (StrictMode remounts create fresh state, which is fine — the
  // double-mount guard stays the cleanup-based cancellation flag). The
  // allocation is a cheap object; only the first render's copy is retained.
  const seqRef = useRef(createRefreshSequence());

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
    const seq = seqRef.current;
    const gen = seq.next();
    const ids = selectedCinemaIds.length === 0 ? undefined : selectedCinemaIds;
    fetchSchedule(ids)
      .then(({ movies, availableDays, cinemaStatuses }) => {
        // Discard superseded responses (late OLDER schedule must never
        // overwrite the latest) as well as unmounted effects.
        if (cancelled || !seq.isCurrent(gen)) return;
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
        if (cancelled || !seq.isCurrent(gen)) return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        // Only the CURRENT fetch controls the loading flag — an older
        // in-flight fetch resolving must not flip it while a newer one runs.
        if (cancelled || !seq.isCurrent(gen)) return;
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedCinemaIds]);

  useEffect(() => reload(), [reload]);

  // React to registry changes (custom cinemas saved/reloaded in the main
  // process): refetch the cinema list and the schedule so new cinemas appear
  // without a restart. Registry source: 'cinemas:changed' IPC via preload.
  useEffect(() => {
    const unsubscribe = onCinemasChanged(() => {
      fetchCinemas()
        .then(setCinemas)
        .catch(() => {
          /* non-fatal */
        });
      reload();
    });
    return unsubscribe;
  }, [reload]);

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
