// ──────────────────────────────────────────────────────────────────────────
// COVERAGE: Layer 1 — Unit tests for pure date/time/normalize helpers.
//
// Tests: parseIsoDay, parseShowtimeDate, toIsoDay, todayIso, formatTime,
//        formatHour, formatDayShort, cinemaColor, cinemaName, normalize, WEEKDAY_FR
//
// Catches: Logic bugs in date parsing, timezone projection errors,
//          accent normalization regressions, BUG-01/BUG-03 regressions.
//
// Misses: Network behavior, HTML parsing, IPC flows, UI rendering.
//        Does NOT validate that date FORMATS are correct for display —
//        that's covered by visual inspection + E2E tests.
//
// See TESTING.md for the full failure-mode → test-layer matrix.
// ──────────────────────────────────────────────────────────────────────────
// ──────────────────────────────────────────────────────────────────────────
// Unit tests for src/shared/cinema.ts — pure date/time/normalize helpers.
//
// These functions are used by BOTH the main process (cinema adapters,
// schedule fetching) and the renderer (filtering, formatting).
// A regression here would affect every cinema + every showtime display.
// ──────────────────────────────────────────────────────────────────────────

import { describe, it, expect, vi } from 'vitest';
import {
  parseIsoDay,
  parseShowtimeDate,
  toIsoDay,
  todayIso,
  formatTime,
  formatHour,
  formatDayShort,
  cinemaColor,
  cinemaName,
  normalize,
  WEEKDAY_FR,
} from '../../src/shared/cinema';
import type { CinemaInfo } from '../../src/shared/types';

// Force the process timezone to Europe/Paris for deterministic tests.
// (The main process does this in src/main/tz.ts — we replicate it here
// so the tests pass regardless of the host machine's local timezone.)
process.env.TZ = 'Europe/Paris';

// ── parseIsoDay ────────────────────────────────────────────────────────────

describe('parseIsoDay', () => {
  it('parses YYYY-MM-DD as noon UTC', () => {
    const d = parseIsoDay('2026-09-19');
    expect(d.getUTCFullYear()).toBe(2026);
    expect(d.getUTCMonth()).toBe(8); // September (0-indexed)
    expect(d.getUTCDate()).toBe(19);
    expect(d.getUTCHours()).toBe(12); // noon UTC
    expect(d.getUTCMinutes()).toBe(0);
  });

  it('produces a valid Date even for February 29 in a leap year', () => {
    const d = parseIsoDay('2024-02-29');
    expect(d.getUTCMonth()).toBe(1);
    expect(d.getUTCDate()).toBe(29);
  });

  it('does NOT shift the calendar date when re-projected to Europe/Paris', () => {
    // BUG-03 regression: previously parsed as host-local midnight, then
    // re-projected to Europe/Paris, which shifted the date by one day on
    // hosts east of UTC+3. Noon UTC is far enough from any DST boundary
    // that the projection is always stable.
    const d = parseIsoDay('2026-09-19');
    const parisDay = d.toLocaleDateString('en-CA', { timeZone: 'Europe/Paris' });
    expect(parisDay).toBe('2026-09-19');
  });
});

// ── parseShowtimeDate ──────────────────────────────────────────────────────

describe('parseShowtimeDate', () => {
  it('parses a valid ISO timestamp', () => {
    const d = parseShowtimeDate('2026-09-19T19:45:00');
    expect(d).not.toBeNull();
    expect(d!.getFullYear()).toBe(2026);
  });

  it('returns null for undefined input (BUG-01 regression)', () => {
    // BUG-01: `new Date(undefined)` returns Invalid Date, and
    // `Intl.DateTimeFormat.formatToParts` throws on Invalid Date rather than
    // returning "Invalid Date". Without this guard, one bad startsAt field
    // would crash the whole cinema's fetch.
    expect(parseShowtimeDate(undefined)).toBeNull();
  });

  it('returns null for null input', () => {
    expect(parseShowtimeDate(null)).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(parseShowtimeDate('')).toBeNull();
  });

  it('returns null for non-string types', () => {
    expect(parseShowtimeDate(12345)).toBeNull();
    expect(parseShowtimeDate({})).toBeNull();
    expect(parseShowtimeDate([])).toBeNull();
  });

  it('returns null for malformed date string', () => {
    expect(parseShowtimeDate('not-a-date')).toBeNull();
    expect(parseShowtimeDate('2026-13-45')).toBeNull(); // invalid month/day
  });
});

// ── toIsoDay ───────────────────────────────────────────────────────────────

describe('toIsoDay', () => {
  it('formats a Date as YYYY-MM-DD in Europe/Paris', () => {
    // 2026-09-19T12:00:00Z → 2026-09-19 in Europe/Paris (UTC+2 in summer)
    const d = new Date('2026-09-19T12:00:00Z');
    expect(toIsoDay(d)).toBe('2026-09-19');
  });

  it('handles midnight UTC correctly (Paris is ahead, so still same day)', () => {
    // 2026-09-19T00:00:00Z → 2026-09-19T02:00:00+02:00 Paris → same day
    const d = new Date('2026-09-19T00:00:00Z');
    expect(toIsoDay(d)).toBe('2026-09-19');
  });

  it('handles 23:00 UTC (next day in Paris during summer)', () => {
    // 2026-09-19T23:00:00Z → 2026-09-20T01:00:00+02:00 Paris → next day
    const d = new Date('2026-09-19T23:00:00Z');
    expect(toIsoDay(d)).toBe('2026-09-20');
  });

  it('handles winter time (UTC+1)', () => {
    // 2026-01-15T23:30:00Z → 2026-01-16T00:30:00+01:00 Paris → next day
    const d = new Date('2026-01-15T23:30:00Z');
    expect(toIsoDay(d)).toBe('2026-01-16');
  });
});

// ── todayIso ────────────────────────────────────────────────────────────────

describe('todayIso', () => {
  it('returns a YYYY-MM-DD string', () => {
    const today = todayIso();
    expect(today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('matches the expected date when called at noon UTC', () => {
    // Use vitest's fake timers to lock the system clock to a fixed point.
    // 2026-09-19T12:00:00Z → 2026-09-19T14:00:00+02:00 Paris (summer UTC+2)
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-19T12:00:00Z'));
    try {
      expect(todayIso()).toBe('2026-09-19');
    } finally {
      vi.useRealTimers();
    }
  });
});

// ── formatTime ──────────────────────────────────────────────────────────────

describe('formatTime', () => {
  // In September (summer time / UTC+2), to display 19h45 in Paris:
  //   19h45 Paris = 17h45 UTC
  // So we pass `T17:45:00Z` to format as `19h45` in Paris TZ.
  //
  // This matches the production behavior — showtimes are stored without a
  // tz designator and interpreted as Paris time, but in tests we can't
  // easily set the host TZ (vitest doesn't propagate env to Date parsing).
  // Using UTC-explicit timestamps is the cleanest workaround.

  it('formats an evening showtime as "19h45"', () => {
    // 17:45 UTC = 19:45 Paris (summer UTC+2)
    expect(formatTime('2026-09-19T17:45:00Z')).toBe('19h45');
  });

  it('formats a morning showtime as "09h30"', () => {
    // 07:30 UTC = 09:30 Paris (summer UTC+2)
    expect(formatTime('2026-09-19T07:30:00Z')).toBe('09h30');
  });

  it('formats midnight as "00h00"', () => {
    // 22:00 UTC = 00:00 Paris (next day, summer UTC+2)
    expect(formatTime('2026-09-19T22:00:00Z')).toBe('00h00');
  });

  it('formats noon as "12h00"', () => {
    // 10:00 UTC = 12:00 Paris (summer UTC+2)
    expect(formatTime('2026-09-19T10:00:00Z')).toBe('12h00');
  });

  it('formats end-of-day as "23h59"', () => {
    // 21:59 UTC = 23:59 Paris (summer UTC+2)
    expect(formatTime('2026-09-19T21:59:00Z')).toBe('23h59');
  });

  it('preserves the Paris timezone projection', () => {
    // 2026-09-19T19:45:00Z (UTC) → 21:45 in Paris summer time (UTC+2)
    expect(formatTime('2026-09-19T19:45:00Z')).toBe('21h45');
  });
});

// ── formatHour ──────────────────────────────────────────────────────────────

describe('formatHour', () => {
  it('formats 19.75 as "19h45"', () => {
    expect(formatHour(19.75)).toBe('19h45');
  });

  it('formats 9.5 as "09h30"', () => {
    expect(formatHour(9.5)).toBe('09h30');
  });

  it('formats 0 as "00h00"', () => {
    expect(formatHour(0)).toBe('00h00');
  });

  it('formats 24 as "24h00"', () => {
    expect(formatHour(24)).toBe('24h00');
  });

  it('rounds 19.999 up to "20h00"', () => {
    // Documented in the source: 19.999 → "20h00" (rounds up cleanly)
    expect(formatHour(19.999)).toBe('20h00');
  });

  it('rounds 19.99 to "19h59"', () => {
    // 0.99 * 60 = 59.4 → rounds to 59
    expect(formatHour(19.99)).toBe('19h59');
  });

  it('handles the 19.999 edge case without producing "19h60"', () => {
    // The fix: if mm >= 60, return `${hh+1}h00` instead of "19h60"
    expect(formatHour(19.999)).not.toMatch(/60$/);
    // 23.999 → hh=23, mm=60 (rounds up), then hh+1=24 → "24h00".
    // The app handles post-midnight times via HOUR_ABSOLUTE_CEIL=28, so
    // "24h00" is a valid display value (midnight showtime shown as 24h00).
    expect(formatHour(23.999)).toBe('24h00');
  });

  it('pads single-digit hours to 2 digits', () => {
    expect(formatHour(8.25)).toBe('08h15');
    expect(formatHour(8.0)).toBe('08h00');
  });

  it('pads single-digit minutes to 2 digits', () => {
    expect(formatHour(19.0833)).toBe('19h05'); // ~5 minutes
    expect(formatHour(19.0167)).toBe('19h01'); // ~1 minute
  });
});

// ── formatDayShort ───────────────────────────────────────────────────────────

describe('formatDayShort', () => {
  it('formats 2026-09-19 as Saturday (Sam)', () => {
    // 2026-09-19 is a Saturday
    const result = formatDayShort('2026-09-19');
    expect(result.weekday).toBe('sam');
    expect(result.dayNum).toBe('19');
    // Month abbreviation depends on ICU, but should contain "sep" or similar
    expect(result.month.length).toBeGreaterThan(0);
  });

  it('formats 2026-01-01 as Thursday (Jeu)', () => {
    // 2026-01-01 is a Thursday
    const result = formatDayShort('2026-01-01');
    expect(result.weekday).toBe('jeu');
    expect(result.dayNum).toBe('01');
  });

  it('returns day number zero-padded to 2 digits', () => {
    const result = formatDayShort('2026-09-09');
    expect(result.dayNum).toBe('09');
  });

  it('does NOT shift the date on hosts in any timezone (BUG-03)', () => {
    // Parse as noon UTC, then format in UTC — the calendar date is stable
    // regardless of the host machine's local timezone.
    const result = formatDayShort('2026-09-19');
    expect(result.dayNum).toBe('19');
  });

  it('returns lowercase weekday without trailing period', () => {
    const result = formatDayShort('2026-09-19');
    expect(result.weekday).not.toMatch(/\.$/);
    expect(result.weekday).toBe(result.weekday.toLowerCase());
  });
});

// ── cinemaColor / cinemaName ─────────────────────────────────────────────────

describe('cinemaColor', () => {
  const cinemas: CinemaInfo[] = [
    { id: 'cine-mont-blanc', name: 'Ciné Mont-Blanc', city: 'Sallanches', color: '#4a9eff' },
    { id: 'cine-vox', name: 'Ciné Vox', city: 'Cluses', color: '#10b981' },
  ];

  it('returns the color for a known cinema', () => {
    expect(cinemaColor(cinemas, 'cine-mont-blanc')).toBe('#4a9eff');
    expect(cinemaColor(cinemas, 'cine-vox')).toBe('#10b981');
  });

  it('returns a neutral gray for an unknown cinema', () => {
    expect(cinemaColor(cinemas, 'unknown-id')).toBe('#888');
  });

  it('returns gray for an empty cinemas list', () => {
    expect(cinemaColor([], 'cine-mont-blanc')).toBe('#888');
  });
});

describe('cinemaName', () => {
  const cinemas: CinemaInfo[] = [
    { id: 'cine-mont-blanc', name: 'Ciné Mont-Blanc', city: 'Sallanches', color: '#4a9eff' },
    { id: 'cine-vox', name: 'Ciné Vox', city: 'Cluses', color: '#10b981' },
  ];

  it('returns the display name for a known cinema', () => {
    expect(cinemaName(cinemas, 'cine-mont-blanc')).toBe('Ciné Mont-Blanc');
    expect(cinemaName(cinemas, 'cine-vox')).toBe('Ciné Vox');
  });

  it('returns the raw id for an unknown cinema', () => {
    expect(cinemaName(cinemas, 'unknown-id')).toBe('unknown-id');
  });
});

// ── normalize ──────────────────────────────────────────────────────────────

describe('normalize', () => {
  it('lowercases ASCII text', () => {
    expect(normalize('Quentin Tarantino')).toBe('quentin tarantino');
  });

  it('strips French diacritics (NFD decomposition)', () => {
    expect(normalize('Réalisateur')).toBe('realisateur');
    expect(normalize('Été')).toBe('ete');
    expect(normalize('naïve')).toBe('naive');
    expect(normalize('café')).toBe('cafe');
  });

  it('normalizes curly apostrophes to straight ones', () => {
    expect(normalize("L'arbre")).toBe("l'arbre");
    expect(normalize('L\u2019arbre')).toBe("l'arbre"); // right single quote
    expect(normalize('L\u2018arbre')).toBe("l'arbre"); // left single quote
    expect(normalize('L\u201barbre')).toBe("l'arbre"); // reversed-9 quote
  });

  it('handles empty string', () => {
    expect(normalize('')).toBe('');
  });

  it('handles numbers + symbols', () => {
    expect(normalize('2026')).toBe('2026');
    expect(normalize('Star Wars: Episode IV')).toBe('star wars: episode iv');
  });

  it('makes accented + non-accented forms comparable', () => {
    // The main use case: search matching. "café" should match "Cafe".
    expect(normalize('café')).toBe(normalize('Cafe'));
    expect(normalize('ÉTÉ')).toBe(normalize('ete'));
  });

  it('preserves hyphens + apostrophes (common in movie titles)', () => {
    expect(normalize('Spider-Man')).toBe('spider-man');
    expect(normalize("L'Auberge Espagnole")).toBe("l'auberge espagnole");
  });
});

// ── WEEKDAY_FR ──────────────────────────────────────────────────────────────

describe('WEEKDAY_FR', () => {
  it('has 7 entries (one per day)', () => {
    expect(WEEKDAY_FR).toHaveLength(7);
  });

  it('is indexed by Date.getDay() (0 = Sunday)', () => {
    // 2026-09-19 is a Saturday (getDay() === 6)
    const d = new Date('2026-09-19T12:00:00Z');
    expect(WEEKDAY_FR[d.getUTCDay()]).toBe('sam'); // samedi
  });

  it('contains the expected French weekday abbreviations', () => {
    expect(WEEKDAY_FR).toEqual(['dim', 'lun', 'mar', 'mer', 'jeu', 'ven', 'sam']);
  });
});
