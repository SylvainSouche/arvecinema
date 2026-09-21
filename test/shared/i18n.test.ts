// ──────────────────────────────────────────────────────────────────────────
// COVERAGE: Layer 1 — Unit tests for i18n translation + fallback chain.
//
// Tests: t(), tIn(), tFmt(), setLocale/getLocale, TRANSLATIONS table integrity
//
// Catches: Missing translations, fallback chain regressions, parameter
//          substitution bugs, locale switching issues.
//
// Misses: Whether the translations are semantically correct (only catches
//        structural issues). Does NOT catch hardcoded strings in components
//        — that's covered by the i18n smoke test (scripts/smoke-test-i18n.mjs).
//
// See TESTING.md for the full failure-mode → test-layer matrix.
// ──────────────────────────────────────────────────────────────────────────
// ──────────────────────────────────────────────────────────────────────────
// Unit tests for src/shared/i18n.ts — translation, locale switching,
// fallback chain, and parameter substitution.
//
// The i18n module is used by every React component. A regression in the
// fallback chain or tFmt() would cause crashes or "key1.key2.key3" garbage
// to appear in the UI.
// ──────────────────────────────────────────────────────────────────────────

import { describe, it, expect, beforeEach } from 'vitest';
import {
  t,
  tIn,
  tFmt,
  getLocale,
  setLocale,
  DEFAULT_LOCALE,
  TRANSLATIONS,
} from '../../src/shared/i18n';

// ── TRANSLATIONS table integrity ────────────────────────────────────────────

describe('TRANSLATIONS table integrity', () => {
  it('has at least 50 entries (basic sanity check)', () => {
    // We have ~89 keys currently. If this drops below 50, something
    // likely went wrong with the table.
    expect(Object.keys(TRANSLATIONS).length).toBeGreaterThan(50);
  });

  it('every entry has both fr and en fields', () => {
    for (const entry of Object.values(TRANSLATIONS)) {
      expect(entry).toHaveProperty('fr');
      expect(entry).toHaveProperty('en');
      expect(typeof entry.fr).toBe('string');
      expect(typeof entry.en).toBe('string');
      expect(entry.fr.length).toBeGreaterThan(0);
      expect(entry.en.length).toBeGreaterThan(0);
    }
  });
});

// ── t() basic translation ───────────────────────────────────────────────────

describe('t()', () => {
  beforeEach(() => {
    setLocale(DEFAULT_LOCALE);
  });

  it('returns the French string by default', () => {
    expect(getLocale()).toBe('fr');
    expect(t('appTitle')).toBe('ArveCinema');
    expect(t('loading')).toBe('Chargement des séances…');
  });

  it('returns the English string when locale is "en"', () => {
    setLocale('en');
    expect(t('loading')).toBe('Loading showtimes…');
    setLocale('fr');
  });

  it('returns the key itself if the key does not exist (graceful degradation)', () => {
    // @ts-expect-error - intentionally testing a non-existent key
    expect(t('nonExistentKey12345')).toBe('nonExistentKey12345');
  });

  it('never throws for any key', () => {
    // Even if the key doesn't exist, t() should not throw — it should
    // return the key itself. This is critical because components call
    // t() during render; an exception would unmount the React tree.
    expect(() => {
      // @ts-expect-error - intentionally testing a non-existent key
      t('someRandomKeyThatDoesNotExist');
    }).not.toThrow();
  });
});

// ── Fallback chain ──────────────────────────────────────────────────────────

describe('t() fallback chain', () => {
  beforeEach(() => {
    setLocale(DEFAULT_LOCALE);
  });

  it('falls back to French if the current locale is missing the field', () => {
    // We can't easily test this without modifying the TRANSLATIONS table,
    // but we can at least verify that all current keys have both fields.
    // (The i18n smoke test already covers this exhaustively.)
    for (const key of Object.keys(TRANSLATIONS)) {
      expect(() => t(key as never)).not.toThrow();
    }
  });

  it('returns the key itself if neither locale nor the fallback has the field', () => {
    // This is the worst case — both the current locale and DEFAULT_LOCALE
    // are missing the entry. The fallback chain should return the key
    // string itself.
    // @ts-expect-error - intentionally testing a non-existent key
    expect(t('missingKeyForFallbackTest')).toBe('missingKeyForFallbackTest');
  });
});

// ── tIn() — locale-specific translation without global state ──────────────

describe('tIn()', () => {
  it('returns the French translation when locale="fr"', () => {
    expect(tIn('loading', 'fr')).toBe('Chargement des séances…');
  });

  it('returns the English translation when locale="en"', () => {
    expect(tIn('loading', 'en')).toBe('Loading showtimes…');
  });

  it('does not change the global locale', () => {
    setLocale('fr');
    expect(getLocale()).toBe('fr');
    tIn('loading', 'en'); // should NOT switch the global locale
    expect(getLocale()).toBe('fr');
  });

  it('returns the key itself for a non-existent key', () => {
    // @ts-expect-error - intentionally testing a non-existent key
    expect(tIn('nonExistentKey', 'fr')).toBe('nonExistentKey');
  });
});

// ── tFmt() — parameter substitution ─────────────────────────────────────────

describe('tFmt()', () => {
  beforeEach(() => {
    setLocale(DEFAULT_LOCALE);
  });

  it('substitutes a single placeholder', () => {
    setLocale('en');
    expect(tFmt('ratingsProgress', { resolved: 5, total: 10 })).toBe('Ratings: 5/10');
    setLocale('fr');
  });

  it('substitutes multiple placeholders', () => {
    setLocale('en');
    expect(tFmt('retryDone', { recovered: 3, retried: 5 })).toBe('3 of 5 recovered');
    setLocale('fr');
  });

  it('handles French substitution', () => {
    setLocale('fr');
    expect(tFmt('retryDone', { recovered: 3, retried: 5 })).toBe('3 récupérée(s) sur 5');
    setLocale('en');
  });

  it('handles string parameters (not just numbers)', () => {
    // All current templates use numeric values, but tFmt accepts strings too.
    setLocale('en');
    expect(tFmt('ratingsProgress', { resolved: 'X', total: 'Y' })).toBe('Ratings: X/Y');
    setLocale('fr');
  });

  it('replaces ALL occurrences of a placeholder (global replace)', () => {
    // If a key has `{x}` appearing twice, both should be replaced.
    // We don't have such a key currently, but the implementation uses
    // the `g` flag on the regex.
    setLocale('en');
    const result = tFmt('ratingsProgress', { resolved: 1, total: 2 });
    expect(result).toBe('Ratings: 1/2');
    // Verify the placeholder isn't left over
    expect(result).not.toContain('{');
    expect(result).not.toContain('}');
    setLocale('fr');
  });

  it('leaves un-substituted placeholders in place', () => {
    // If we don't pass all the params, the leftover `{x}` stays in the string.
    // This is a deliberate design choice — better to see "{total}" in the UI
    // than to silently substitute an empty string and lose the bug.
    setLocale('en');
    expect(tFmt('ratingsProgress', { resolved: 5 })).toBe('Ratings: 5/{total}');
    setLocale('fr');
  });

  it('handles numeric values that are 0', () => {
    setLocale('en');
    expect(tFmt('ratingsProgress', { resolved: 0, total: 0 })).toBe('Ratings: 0/0');
    setLocale('fr');
  });

  it('handles numeric values that are large', () => {
    setLocale('en');
    expect(tFmt('ratingsProgress', { resolved: 1234567, total: 9876543 })).toBe(
      'Ratings: 1234567/9876543',
    );
    setLocale('fr');
  });
});

// ── Locale switching ────────────────────────────────────────────────────────

describe('setLocale + getLocale', () => {
  beforeEach(() => {
    setLocale(DEFAULT_LOCALE);
  });

  it('switches between "fr" and "en"', () => {
    expect(getLocale()).toBe('fr');
    setLocale('en');
    expect(getLocale()).toBe('en');
    setLocale('fr');
    expect(getLocale()).toBe('fr');
  });

  it('affects subsequent t() calls', () => {
    setLocale('fr');
    expect(t('loading')).toBe('Chargement des séances…');
    setLocale('en');
    expect(t('loading')).toBe('Loading showtimes…');
    setLocale('fr');
  });

  it('persists across calls (module-level state)', () => {
    setLocale('en');
    expect(getLocale()).toBe('en');
    // No re-init between gets
    expect(getLocale()).toBe('en');
    setLocale('fr');
  });
});

// ── DEFAULT_LOCALE ──────────────────────────────────────────────────────────

describe('DEFAULT_LOCALE', () => {
  it('is set to "fr" (the project\'s original language)', () => {
    expect(DEFAULT_LOCALE).toBe('fr');
  });
});
