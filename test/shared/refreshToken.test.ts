// ──────────────────────────────────────────────────────────────────────────
// refreshToken semantics tests — the deterministic generation guard used by
// schedule:fetch (main) and useSchedule (renderer) so that a delayed OLDER
// response can never overwrite the latest state (review race fix).
//
// No clocks, no randomness: the "delayed older schedule" scenario is
// simulated with explicit interleavings below.
// ──────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from 'vitest';
import { createRefreshSequence } from '../../src/shared/refreshToken';

describe('createRefreshSequence', () => {
  it('the newest generation is current; every earlier one is stale', () => {
    const seq = createRefreshSequence();
    const a = seq.next();
    expect(seq.isCurrent(a)).toBe(true);

    const b = seq.next();
    expect(seq.isCurrent(b)).toBe(true);
    expect(seq.isCurrent(a)).toBe(false); // superseded
    expect(seq.current()).toBe(b);
  });

  it('delayed OLDER response arriving AFTER the newer one is discarded', () => {
    const seq = createRefreshSequence();
    // Renderer fires refresh A…
    const a = seq.next();
    // …a newer refresh B starts while A is still in flight…
    const b = seq.next();
    // …and B resolves FIRST…
    expect(seq.isCurrent(b)).toBe(true);
    // …then the DELAYED older A finally resolves: must NOT be applied.
    expect(seq.isCurrent(a)).toBe(false);
  });

  it('a response still current after an interleaved chain stays valid only until the next next()', () => {
    const seq = createRefreshSequence();
    const a = seq.next();
    const aApplied = seq.isCurrent(a); // applied now
    expect(aApplied).toBe(true);
    seq.next(); // any new refresh — even for the same selection — invalidates it
    expect(seq.isCurrent(a)).toBe(false);
  });

  it('rapid triple-refresh: only the last token survives', () => {
    const seq = createRefreshSequence();
    const t1 = seq.next();
    const t2 = seq.next();
    const t3 = seq.next();
    expect(seq.isCurrent(t1)).toBe(false);
    expect(seq.isCurrent(t2)).toBe(false);
    expect(seq.isCurrent(t3)).toBe(true);
  });

  it('errors from a superseded fetch are also suppressed (same token check)', () => {
    // The renderer guards .catch and .finally with the same isCurrent, so a
    // stale fetch's error cannot clobber a newer attempt's error/state.
    const seq = createRefreshSequence();
    const a = seq.next();
    seq.next();
    const suppressed = !seq.isCurrent(a);
    expect(suppressed).toBe(true);
  });

  it('sequences are independent (hook instances do not interfere)', () => {
    const s1 = createRefreshSequence();
    const s2 = createRefreshSequence();
    const a1 = s1.next();
    const a2 = s2.next();
    expect(s1.isCurrent(a1)).toBe(true);
    expect(s2.isCurrent(a2)).toBe(true);
    s2.next();
    expect(s1.isCurrent(a1)).toBe(true); // s2 activity doesn't touch s1
  });

  it('tokens are strictly monotonic integers (no clock dependence)', () => {
    const seq = createRefreshSequence();
    const seen: number[] = [seq.next(), seq.next(), seq.next()];
    expect(seen).toEqual([1, 2, 3]);
  });
});
