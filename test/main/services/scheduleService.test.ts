// ──────────────────────────────────────────────────────────────────────────
// scheduleService tests — schedule-refresh orchestration, extracted from
// main/index.ts (ARCH-01). All seams injected: no electron, no adapters, no
// network. Includes the refresh-generation race regression: a superseded
// run's per-movie publishes are suppressed by the service itself.
// ──────────────────────────────────────────────────────────────────────────

import { describe, it, expect, vi } from 'vitest';
import {
  fetchSchedules,
  classifyCinemaError,
  type ScheduleServiceDeps,
} from '../../../src/main/services/scheduleService';
import type { Movie } from '../../../src/main/cinemas/types';

const movie = (id: string, cinemaId: string, title: string): Movie =>
  ({ id, cinemaId, title, showtimes: [], hasVF: true, hasVO: false }) as unknown as Movie;

/** Default deps: the fetch seam honors the enabled cinema's own .fetch. */
function makeDeps(overrides?: Partial<ScheduleServiceDeps>) {
  const publishes: Movie[] = [];
  const errors: string[] = [];
  const deps: ScheduleServiceDeps = {
    fetchScheduleOf: (c, days) => c.fetch(days),
    enrich: vi.fn(async () => undefined),
    publishRatingUpdate: (m) => publishes.push(m),
    logError: (id, reason, msg) => errors.push(`${id}:${reason}:${msg}`),
    ...overrides,
  };
  return { deps, publishes, errors };
}

describe('classifyCinemaError', () => {
  it('TimeoutError → timeout, schema errors → parse-error, rest → http-error', () => {
    expect(classifyCinemaError(Object.assign(new Error('t'), { name: 'TimeoutError' }))).toEqual({
      reason: 'timeout',
      message: 't',
    });
    expect(
      classifyCinemaError(Object.assign(new Error('s'), { name: 'ScraperSchemaChangedError' })),
    ).toEqual({ reason: 'parse-error', message: 's' });
    expect(classifyCinemaError(new Error('ECONNREFUSED'))).toEqual({
      reason: 'http-error',
      message: 'ECONNREFUSED',
    });
    expect(classifyCinemaError('boom string').reason).toBe('http-error');
    expect(classifyCinemaError(undefined).message).toBe('undefined');
  });
});

describe('fetchSchedules', () => {
  const ok = (id: string, days: string[], titles: string[]) => ({
    id,
    fetch: async () => ({ availableDays: days, movies: titles.map((t) => movie(`${id}-${t}`, id, t)) }),
  });

  it('aggregates parallel fetches: statuses, global fr-title sort with cinemaId tiebreak, union days', async () => {
    const { deps } = makeDeps();
    const res = await fetchSchedules(deps, {
      enabled: [
        ok('b', ['2026-01-03'], ['Bêtise', 'Alpha']), // fr collation: Alpha < Bêtise
        ok('a', ['2026-01-01', '2026-01-03'], ['Alpha']), // dup day + same title at 2 cinemas
      ],
      days: 14,
      isStale: () => false,
    });
    expect(res.availableDays).toEqual(['2026-01-01', '2026-01-03']); // union + sorted + deduped
    expect(res.movies.map((m) => [m.title, m.cinemaId])).toEqual([
      ['Alpha', 'a'],
      ['Alpha', 'b'],
      ['Bêtise', 'b'],
    ]);
    expect(res.cinemaStatuses).toEqual([
      { cinemaId: 'b', status: 'ok' },
      { cinemaId: 'a', status: 'ok' },
    ]);
  });

  it('a failing cinema yields a classified status + no movies, others still served', async () => {
    const { deps, errors } = makeDeps();
    const res = await fetchSchedules(deps, {
      enabled: [
        ok('good', ['d1'], ['Film']),
        { id: 'bad', fetch: async () => { throw Object.assign(new Error('503'), { name: 'TimeoutError' }); } },
      ],
      days: 14,
      isStale: () => false,
    });
    expect(res.cinemaStatuses).toEqual([
      { cinemaId: 'good', status: 'ok' },
      { cinemaId: 'bad', status: 'timeout', error: '503' },
    ]);
    expect(res.movies.map((m) => m.cinemaId)).toEqual(['good']);
    expect(errors).toEqual(['bad:timeout:503']);
  });

  it('relays per-movie enrichment publishes to the publish seam', async () => {
    const { deps, publishes } = makeDeps({
      enrich: async (_movies, onUpdated) => onUpdated(movie('x', 'a', 'Alpha')),
    });
    await fetchSchedules(deps, {
      enabled: [ok('a', ['d'], ['Alpha'])],
      days: 14,
      isStale: () => false,
    });
    expect(publishes.map((m) => m.id)).toEqual(['x']);
  });

  it('RACE: a superseded run (isStale) suppresses per-movie publishes', async () => {
    // Older refresh in flight… newer refresh starts ("isStale" now true)…
    const { deps, publishes } = makeDeps({
      enrich: async (_movies, onUpdated) => onUpdated(movie('late', 'a', 'Alpha')),
    });
    await fetchSchedules(deps, {
      enabled: [ok('a', ['d'], ['Alpha'])],
      days: 14,
      isStale: () => true,
    });
    expect(publishes).toEqual([]); // nothing broadcast for the stale run
  });

  it('dev export mode awaits enrichment completion before returning', async () => {
    let enrichmentDone = false;
    const { deps } = makeDeps({
      enrich: async () => {
        await new Promise((r) => setTimeout(r, 10));
        enrichmentDone = true;
      },
    });
    await fetchSchedules(deps, {
      enabled: [ok('a', ['d'], ['Alpha'])],
      days: 14,
      isStale: () => false,
      awaitEnrichment: true,
    });
    expect(enrichmentDone).toBe(true);
  });

  it('normal UI refresh resolves BEFORE enrichment completes (progressive)', async () => {
    let enrichmentDone = false;
    const { deps } = makeDeps({
      enrich: async () => {
        await new Promise((r) => setTimeout(r, 10));
        enrichmentDone = true;
      },
    });
    const res = await fetchSchedules(deps, {
      enabled: [ok('a', ['d'], ['Alpha'])],
      days: 14,
      isStale: () => false,
    });
    expect(res.movies).toHaveLength(1); // response not blocked by enrichment
    expect(enrichmentDone).toBe(false);
  });
});
