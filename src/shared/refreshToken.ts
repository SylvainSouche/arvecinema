// ──────────────────────────────────────────────────────────────────────────
// refreshToken — monotonic generation token for refresh flows.
//
// Review race-fix: a delayed OLDER schedule response must never overwrite
// the latest schedule (user taps ↻ twice, or 'cinemas:changed' triggers a
// refetch while a manual refresh is in flight — whatever resolves LAST
// used to win, not what is newest).
//
// Semantics (unit-tested in test/shared/refreshToken.test.ts):
//   const seq = createRefreshSequence();
//   const a = seq.next();
//   const b = seq.next();          // b supersedes a
//   seq.isCurrent(a) === false     // a's late response is discarded
//   seq.isCurrent(b) === true
//
// The token is a plain counter — no clocks, no randomness, so the guard is
// deterministic and safe to use in both the main process (superseding
// rating:updated broadcasts from a stale enrichment run) and the renderer
// (discarding stale useSchedule responses).
// ──────────────────────────────────────────────────────────────────────────

export interface RefreshSequence {
  /** Start a new generation; returns its token. Supersedes all previous. */
  next(): number;
  /** True iff `token` is the most recently issued generation. */
  isCurrent(token: number): boolean;
  /** Current generation number (diagnostics/tests). */
  current(): number;
}

export function createRefreshSequence(): RefreshSequence {
  let current = 0;
  return {
    next: () => {
      return ++current;
    },
    isCurrent: (token: number) => token === current,
    current: () => current,
  };
}
