// ──────────────────────────────────────────────────────────────────────────
// Refresh-generation wiring contract (review race fix).
//
// Pins that:
//   1. services/ipcRegistrar.ts (the schedule:fetch owner) starts a new
//      generation per fetch and passes an isStale gate built on it to the
//      enricher;
//   2. ratingsEnricher actually honors isStale (progress + per-movie updates
//      both suppressed for superseded runs);
//   3. useSchedule guards response application (apply/error/loading) with
//      the same token semantics.
// Source-audit pattern (electron modules can't be imported unmocked in
// vitest); the token SEMANTICS themselves are unit-tested
// in test/shared/refreshToken.test.ts.
// ──────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const read = (rel: string): string => fs.readFileSync(path.join(process.cwd(), rel), 'utf8');

describe('race contract: main process generation gating', () => {
  const registrar = () => read('src/main/services/ipcRegistrar.ts');

  it('schedule:fetch opens a new generation and passes isStale to the enricher', () => {
    const s = registrar();
    expect(s).toMatch(/createRefreshSequence\(\)/);
    expect(s).toMatch(/const gen = refreshSeq\.next\(\)/);
    // isStale is derived from THIS run's generation...
    expect((s.match(/!refreshSeq\.isCurrent\(gen\)/g) ?? []).length).toBe(2); // schedule:fetch + dev:export-all
    // ...and reaches enrichWithRatings through the service's enrich seam.
    expect(s).toMatch(
      /enrich: \(movies, onUpdated, opts\) => enrichWithRatings\(movies, onUpdated, opts\)/,
    );
  });

  it('ratingsEnricher honors the isStale gate (progress + updates)', () => {
    const s = read('src/main/ratings/ratingsEnricher.ts');
    expect(s).toMatch(/isStale\?\.()/);
    expect(s).toMatch(/progressStaleCheck = isStale/); // registered BEFORE resetProgress
    expect(s).toMatch(/const guardedOnUpdated/); // per-movie updates gated
    // The guarded callback must be what reaches every pipeline phase.
    const guardedUses = (s.match(/guardedOnUpdated/g) ?? []).length;
    expect(guardedUses).toBeGreaterThanOrEqual(6); // applyCachedIds, cache ratings, dataset refresh, phase1 (×2), batchImdbLookup, scrapeAll
  });
});

describe('race contract: renderer response guard', () => {
  const hook = () => read('src/renderer/hooks/useSchedule.ts');

  it('useSchedule tokens every reload and applies only the current generation', () => {
    const s = hook();
    expect(s).toMatch(/createRefreshSequence/);
    expect(s).toMatch(/const gen = seq\.next\(\)/);
    // apply / error / loading all guarded by the ORIGINAL cancelled flag
    // PLUS the generation check:
    expect((s.match(/cancelled \|\| !seq\.isCurrent\(gen\)/g) ?? []).length).toBe(3);
    // raw unguarded setMovies no longer exists (all paths guarded)
    expect(s).not.toMatch(/if \(!cancelled\) set/);
  });
});
