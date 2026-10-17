// ──────────────────────────────────────────────────────────────────────────
// IPC validation boundary tests (review IPC-01).
//
// Pure/electron-free: parse/sanitize only. The handlers' WIRING (which
// handler calls which validator + the sender check) is pinned separately
// by test/main/securityContract.test.ts.
// ──────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from 'vitest';
import {
  parseCinemaIdsInput,
  parseRetryMoviesInput,
  defaultSanitizeString,
} from '../../src/main/security/ipcValidation';

const KNOWN = new Set(['mont-blanc', 'cluses', 'cinevox-annecy']);

describe('parseCinemaIdsInput', () => {
  it('undefined/null means "all cinemas" (empty list)', () => {
    expect(parseCinemaIdsInput(undefined)).toEqual({ ok: true, value: [] });
    expect(parseCinemaIdsInput(null)).toEqual({ ok: true, value: [] });
  });

  it('accepts conforming id arrays', () => {
    expect(parseCinemaIdsInput(['mont-blanc', 'cinevox-annecy'])).toEqual({
      ok: true,
      value: ['mont-blanc', 'cinevox-annecy'],
    });
  });

  it('rejects non-arrays wholesale', () => {
    expect(parseCinemaIdsInput('mont-blanc').ok).toBe(false);
    expect(parseCinemaIdsInput({ 0: 'mont-blanc' }).ok).toBe(false);
  });

  it('rejects non-conforming ids (injection-y or oversized)', () => {
    expect(parseCinemaIdsInput([42]).ok).toBe(false);
    expect(parseCinemaIdsInput(['../etc/passwd']).ok).toBe(false);
    expect(parseCinemaIdsInput(['x'.repeat(65)]).ok).toBe(false);
    expect(parseCinemaIdsInput(['']).ok).toBe(false);
  });

  it('rejects oversized arrays (no main-process work amplification)', () => {
    expect(parseCinemaIdsInput(Array(101).fill('mont-blanc')).ok).toBe(false);
  });
});

describe('parseRetryMoviesInput', () => {
  const baseMovie = {
    id: '307123',
    cinemaId: 'mont-blanc',
    title: 'Le Film',
    hasVF: true,
    hasVO: false,
    showtimes: [],
    wikidataUrl: 'https://www.wikidata.org/entity/Q123456',
    imdbStatus: 'blocked',
    allocineStatus: 'ok',
    rtStatus: 'blocked',
  };

  it('keeps structurally-valid movies with their benign fields', () => {
    const res = parseRetryMoviesInput([baseMovie], KNOWN, defaultSanitizeString);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value).toHaveLength(1);
    expect(res.value[0].id).toBe('307123');
    expect(res.value[0].imdbStatus).toBe('blocked');
    expect(res.value[0].rtStatus).toBe('blocked');
    expect(res.value[0].wikidataUrl).toContain('Q123456');
  });

  it('drops forged/unknown cinemaIds and garbage rows instead of crashing', () => {
    const res = parseRetryMoviesInput(
      [
        null,
        'a string',
        42,
        { ...baseMovie, cinemaId: 'evil-cinema' }, // unknown cinema
        { ...baseMovie, id: '../x' }, // bad id pattern
        { ...baseMovie, title: 42 }, // bad title
        { ...baseMovie, id: 'ok-id', cinemaId: 'cluses', title: 'Have Title' },
      ],
      KNOWN,
      defaultSanitizeString,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value).toHaveLength(1);
    expect(res.value[0].id).toBe('ok-id');
  });

  it('fails when nothing valid survived (no silent "retried 0 movies" mask)', () => {
    const res = parseRetryMoviesInput(['garbage'], KNOWN, defaultSanitizeString);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/no structurally-valid movies/);
  });

  it('rejects oversized arrays', () => {
    const movies = Array(1001).fill(baseMovie);
    expect(parseRetryMoviesInput(movies, KNOWN, defaultSanitizeString).ok).toBe(false);
  });

  it('unknown object keys do NOT survive sanitization (no Object.create pollution)', () => {
    const sneaky = JSON.parse(
      JSON.stringify({
        ...baseMovie,
        __proto__: { polluted: 'yes' },
        extra: 'drop me',
        direction: 'Someone\n\u0001 weird',
      }),
    ) as Record<string, unknown>;
    const res = parseRetryMoviesInput([sneaky], KNOWN, defaultSanitizeString);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const clean = res.value[0] as unknown as Record<string, unknown>;
    expect(clean.extra).toBeUndefined();
    // Control characters removed from sanitized strings.
    expect(clean.direction).toBe('Someone weird');
  });

  it('wikidataUrl present but statuses invalid → statuses normalized to undefined', () => {
    const res = parseRetryMoviesInput(
      [{ ...baseMovie, imdbStatus: 'forged' as unknown as string }],
      KNOWN,
      defaultSanitizeString,
    );
    if (res.ok) expect(res.value[0].imdbStatus).toBeUndefined();
    else throw new Error('expected ok');
  });
});
