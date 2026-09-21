import { useState, useEffect, useCallback } from 'react';
import type { Movie } from '../../shared/types';

// ──────────────────────────────────────────────────────────────────────────
// useRetryFailedLookups — manages the retry button state.
//
// State machine:
//   null → { inProgress: true } → { inProgress: false, recovered, retried, at }
//   → null (after 4s auto-clear)
//
// The handler sends the current movie list to the main process via the
// `ratings:retry` IPC channel. Updates flow back via `onRatingUpdated`
// (handled separately in useRatingsIPC) — the UI just sees blocked badges
// turn into scores as each retry succeeds.
// ──────────────────────────────────────────────────────────────────────────

export type RetryState =
  | null
  | { inProgress: true }
  | { inProgress: false; recovered: number; retried: number; at: number };

export function useRetryFailedLookups(
  movies: Movie[],
  blockedCount: number,
): {
  retryState: RetryState;
  handleRetry: () => Promise<void>;
} {
  const [retryState, setRetryState] = useState<RetryState>(null);

  const handleRetry = useCallback(async () => {
    if (retryState?.inProgress) return; // prevent double-clicks
    if (blockedCount === 0) return;

    setRetryState({ inProgress: true });
    try {
      const result = await window.electronAPI.retryFailedLookups(
        movies.map((m) => ({
          cinemaId: m.cinemaId,
          id: m.id,
          title: m.title,
          wikidataUrl: m.wikidataUrl,
          imdbStatus: m.imdbStatus,
          allocineStatus: m.allocineStatus,
          rtStatus: m.rtStatus,
        })),
      );
      setRetryState({
        inProgress: false,
        recovered: result.succeeded,
        retried: result.succeeded + result.stillFailing,
        at: Date.now(),
      });
    } catch (err) {
      // Don't crash — just silently clear the in-progress state.
      console.error('[retry] failed:', err);
      setRetryState(null);
    }
  }, [retryState, blockedCount, movies]);

  // Auto-clear the "done" toast 4s after retry completes.
  useEffect(() => {
    if (retryState && !retryState.inProgress) {
      const t = setTimeout(() => setRetryState(null), 4000);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [retryState]);

  return { retryState, handleRetry };
}
