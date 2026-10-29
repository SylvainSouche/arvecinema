import { useState, useEffect, useCallback } from 'react';
import { t } from '../../shared/i18n';

// ──────────────────────────────────────────────────────────────────────────
// useInvalidateCaches — manages the "invalidate caches" button state.
//
// State machine (mirrors useRetryFailedLookups):
//   null → { inProgress: true } → { inProgress: false, cleared, at }
//   → null (after 4s auto-clear)
//
// Click flow: confirm dialog → `ratings:invalidate-cache` (main process
// deletes every ratings_cache row) → automatic `refresh()` so the enrichment
// re-scrapes all sources from scratch. The title tooltip shows
// "{cleared} cleared" for 4s after completion.
// ──────────────────────────────────────────────────────────────────────────

export type InvalidateState =
  | null
  | { inProgress: true }
  | { inProgress: false; cleared: number; at: number };

export function useInvalidateCaches(
  refresh: () => void,
  networkActive: boolean,
): {
  invalidateState: InvalidateState;
  handleInvalidate: () => Promise<void>;
} {
  const [invalidateState, setInvalidateState] = useState<InvalidateState>(null);

  const handleInvalidate = useCallback(async () => {
    if (invalidateState?.inProgress) return; // prevent double-clicks
    if (networkActive) return; // never wipe the cache mid-enrichment

    // t() reads the current module locale — same copy the button shows.
    if (!window.confirm(t('invalidateCacheConfirm'))) return;

    setInvalidateState({ inProgress: true });
    try {
      const { cleared } = await window.electronAPI.invalidateRatingsCache();
      setInvalidateState({ inProgress: false, cleared, at: Date.now() });
      // Re-fetch schedules + re-enrich from the now-empty ratings cache.
      refresh();
    } catch (err) {
      // Don't crash — just silently clear the in-progress state.
      console.error('[invalidate-caches] failed:', err);
      setInvalidateState(null);
    }
  }, [invalidateState, networkActive, refresh]);

  // Auto-clear the "done" tooltip 4s after completion.
  useEffect(() => {
    if (invalidateState && !invalidateState.inProgress) {
      const timer = setTimeout(() => setInvalidateState(null), 4000);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [invalidateState]);

  return { invalidateState, handleInvalidate };
}
