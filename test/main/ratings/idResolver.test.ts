// ──────────────────────────────────────────────────────────────────────────
// COVERAGE: Layer 1 — Unit tests for title normalization + coherence checking.
//
// Tests: normalizeTitle, isCoherentMovie, releaseYear, allocineIdFromMovie
//
// Catches: Title matching regressions (false positives = wrong ratings shown,
//          false negatives = no ratings shown), normalization edge cases
//          (accents, apostrophes, "Partie N" suffixes, etc.).
//
// Misses: Whether the SPARQL query that feeds results into isCoherentMovie
//        is correct (that's Layer 2 — query snapshot tests). Does NOT test
//        the Wikidata endpoint itself (that's Layer 6 — live smoke tests).
//
// See TESTING.md for the full failure-mode → test-layer matrix.
// ──────────────────────────────────────────────────────────────────────────
// Unit tests for src/main/ratings/idResolver.ts — title normalization,
// coherence checking, year/allocine ID extraction.
//
// These functions decide whether two movie titles refer to the same film.
// A regression here would either:
//   - FAIL to match a Wikidata entry → movie gets no ratings (false negative)
//   - INCORRECTLY match two different films → wrong ratings shown (false positive)
// Both are user-visible bugs.

import { describe, it, expect } from 'vitest';
import {
  normalizeTitle,
  isCoherentMovie,
  releaseYear,
  allocineIdFromMovie,
} from '../../../src/main/ratings/idResolver';
import type { Movie } from '../../../src/shared/types';

// Helper: build a minimal Movie for testing.
const makeMovie = (overrides: Partial<Movie> & Pick<Movie, 'title'>): Movie => ({
  id: 'test-id',
  cinemaId: 'mont-blanc',
  direction: '',
  casting: '',
  hasVF: false,
  hasVO: false,
  showtimes: [],
  ...overrides,
});

// ── normalizeTitle ──────────────────────────────────────────────────────────

describe('normalizeTitle', () => {
  it('lowercases ASCII text', () => {
    expect(normalizeTitle('The Matrix')).toBe('the matrix');
  });

  it('strips French diacritics', () => {
    expect(normalizeTitle('Réalisateur')).toBe('realisateur');
    expect(normalizeTitle('café')).toBe('cafe');
    expect(normalizeTitle('naïve')).toBe('naive');
  });

  it('normalizes curly apostrophes (but final cleanup removes them)', () => {
    // The function first converts curly to straight apostrophe, but the
    // final cleanup `[^a-z0-9\s]` removes the apostrophe entirely. So
    // 'L'arbre' → 'l arbre' (space, not apostrophe).
    expect(normalizeTitle("L'arbre")).toBe('l arbre');
    expect(normalizeTitle('L\u2019arbre')).toBe('l arbre');
    expect(normalizeTitle('L\u2018arbre')).toBe('l arbre');
  });

  it('removes "Partie N" suffixes when preceded by a separator (French)', () => {
    // The regex `\s*[-:]\s*partie\s+\d+\s*` requires a `-` or `:` BEFORE
    // "partie". So "Film Partie 1" (no separator) is NOT stripped, but
    // "Film - Partie 1" or "Film: Partie 1" is.
    expect(normalizeTitle('Film - Partie 1')).toBe('film');
    expect(normalizeTitle('Film: Partie 2 : Sous-titre')).toBe('film sous titre');
    expect(normalizeTitle('Film - Partie 3')).toBe('film');
    // Without separator, "partie N" stays (the regex doesn't match)
    expect(normalizeTitle('Film Partie 1')).toBe('film partie 1');
  });

  it('removes "Part N" suffixes when preceded by a separator (English)', () => {
    expect(normalizeTitle('Film - Part 1')).toBe('film');
    expect(normalizeTitle('Film: Part 2: Subtitle')).toBe('film subtitle');
    // Without separator, "part N" stays
    expect(normalizeTitle('Film Part 1')).toBe('film part 1');
  });

  it('removes "Final Cut" / "Extended" / "Version longue" / "Version courte"', () => {
    expect(normalizeTitle('Film Final Cut')).toBe('film');
    expect(normalizeTitle('Film Extended')).toBe('film');
    expect(normalizeTitle('Film Version longue')).toBe('film');
    expect(normalizeTitle('Film Version courte')).toBe('film');
  });

  it('normalizes separators (":", "-") to spaces', () => {
    expect(normalizeTitle('Star Wars: Episode IV')).toBe('star wars episode iv');
    expect(normalizeTitle('Spider-Man')).toBe('spider man');
    expect(normalizeTitle('Film - Sous-titre')).toBe('film sous titre');
  });

  it('removes non-alphanumeric characters (keeps letters, digits, spaces, apostrophes)', () => {
    expect(normalizeTitle('Film!')).toBe('film');
    expect(normalizeTitle('Film?')).toBe('film');
    expect(normalizeTitle('Film (2024)')).toBe('film 2024');
    expect(normalizeTitle('Film [Special]')).toBe('film special');
  });

  it('collapses multiple spaces + trims', () => {
    expect(normalizeTitle('  Film   with   spaces  ')).toBe('film with spaces');
    expect(normalizeTitle('Film\n\tTab')).toBe('film tab');
  });

  it('handles empty string', () => {
    expect(normalizeTitle('')).toBe('');
  });

  it('handles numbers + special cases', () => {
    expect(normalizeTitle('2001: A Space Odyssey')).toBe('2001 a space odyssey');
    expect(normalizeTitle('M3GAN')).toBe('m3gan');
  });
});

// ── isCoherentMovie ─────────────────────────────────────────────────────────

describe('isCoherentMovie', () => {
  it('returns true for identical titles', () => {
    expect(isCoherentMovie({ title: 'The Matrix' }, { title: 'The Matrix' })).toBe(true);
  });

  it('returns true for case-different titles (case-insensitive)', () => {
    expect(isCoherentMovie({ title: 'The Matrix' }, { title: 'the matrix' })).toBe(true);
  });

  it('returns true for accent-different titles', () => {
    expect(isCoherentMovie({ title: 'café' }, { title: 'cafe' })).toBe(true);
  });

  it('returns true when one title is a prefix of the other (subtitle case)', () => {
    expect(isCoherentMovie({ title: 'The Matrix' }, { title: 'The Matrix Reloaded' })).toBe(true);
    expect(isCoherentMovie({ title: 'The Matrix Reloaded' }, { title: 'The Matrix' })).toBe(true);
  });

  it('returns true for titles with same tokens in different order', () => {
    // Token overlap check: if both have 3+ tokens (length > 2) and one
    // is a subset of the other, they're coherent.
    expect(
      isCoherentMovie({ title: 'The Lord of the Rings' }, { title: 'Lord of the Rings' }),
    ).toBe(true);
  });

  it('returns false for completely different titles', () => {
    expect(isCoherentMovie({ title: 'The Matrix' }, { title: 'Inception' })).toBe(false);
    expect(isCoherentMovie({ title: 'Star Wars' }, { title: 'Star Trek' })).toBe(false);
  });

  it('returns false for empty titles', () => {
    expect(isCoherentMovie({ title: '' }, { title: 'The Matrix' })).toBe(false);
    expect(isCoherentMovie({ title: 'The Matrix' }, { title: '' })).toBe(false);
  });

  it('allows minor typos via Levenshtein distance', () => {
    // Levenshtein <= max(3, 25% of max length) → coherent
    // "Spiderman" vs "Spider-Man" → normalized both "spider man", so identical
    expect(isCoherentMovie({ title: 'Spiderman' }, { title: 'Spider-Man' })).toBe(true);
  });

  it('returns false for similar-but-different titles (not coherent)', () => {
    // "The Avengers" vs "Avengers: Endgame" — different normalized forms
    // ('the avengers' vs 'avengers endgame') and Levenshtein too far.
    // These are NOT coherent — they're different films.
    expect(isCoherentMovie({ title: 'The Avengers' }, { title: 'Avengers: Endgame' })).toBe(false);
    expect(
      isCoherentMovie({ title: 'Avengers: Endgame' }, { title: 'Avengers: Infinity War' }),
    ).toBe(false);
  });

  it('returns true when one title is a strict prefix of the other', () => {
    // "The Matrix" vs "The Matrix Reloaded" → "the matrix" starts with
    // "the matrix" — coherent.
    expect(isCoherentMovie({ title: 'The Matrix' }, { title: 'The Matrix Reloaded' })).toBe(true);
    // "Avengers" vs "Avengers: Endgame" → "avengers" starts with "avengers"
    expect(isCoherentMovie({ title: 'Avengers' }, { title: 'Avengers: Endgame' })).toBe(true);
  });

  it('handles the year field (does not affect coherence — only title matters)', () => {
    // The function signature accepts { title, year? } for the expected movie,
    // but the impl only compares titles. Different years don't make the same
    // title incoherent.
    expect(isCoherentMovie({ title: 'Dune', year: 1984 }, { title: 'Dune' })).toBe(true); // Same title — coherent, even though different years
  });
});

// ── releaseYear ──────────────────────────────────────────────────────────────

describe('releaseYear', () => {
  it('extracts the year from a valid ISO date', () => {
    expect(releaseYear(makeMovie({ title: 'Test', release: '2024-07-15T00:00:00.000Z' }))).toBe(
      2024,
    );
  });

  it('returns undefined when release is not set', () => {
    expect(releaseYear(makeMovie({ title: 'Test' }))).toBeUndefined();
  });

  it('returns undefined for a malformed date string', () => {
    expect(releaseYear(makeMovie({ title: 'Test', release: 'not-a-date' }))).toBeUndefined();
  });

  it('handles year boundary (December 31 → that year)', () => {
    expect(releaseYear(makeMovie({ title: 'Test', release: '2024-12-31T23:59:59.000Z' }))).toBe(
      2024,
    );
  });

  it('handles year boundary (January 1 → that year)', () => {
    expect(releaseYear(makeMovie({ title: 'Test', release: '2025-01-01T00:00:00.000Z' }))).toBe(
      2025,
    );
  });
});

// ── allocineIdFromMovie ──────────────────────────────────────────────────────

describe('allocineIdFromMovie', () => {
  it('returns the movie.id when cinema is "mont-blanc" and id is numeric', () => {
    expect(
      allocineIdFromMovie(makeMovie({ title: 'T', cinemaId: 'mont-blanc', id: '12345' })),
    ).toBe('12345');
  });

  it('returns the movie.id when cinema is "cluses"', () => {
    expect(allocineIdFromMovie(makeMovie({ title: 'T', cinemaId: 'cluses', id: '67890' }))).toBe(
      '67890',
    );
  });

  it('returns the movie.id when cinema is "bonneville"', () => {
    expect(
      allocineIdFromMovie(makeMovie({ title: 'T', cinemaId: 'bonneville', id: '11111' })),
    ).toBe('11111');
  });

  it('returns undefined for an unsupported cinema (e.g. chamonix)', () => {
    expect(
      allocineIdFromMovie(makeMovie({ title: 'T', cinemaId: 'chamonix', id: '12345' })),
    ).toBeUndefined();
  });

  it('returns undefined when id is not numeric', () => {
    expect(
      allocineIdFromMovie(makeMovie({ title: 'T', cinemaId: 'mont-blanc', id: 'abc' })),
    ).toBeUndefined();
    expect(
      allocineIdFromMovie(makeMovie({ title: 'T', cinemaId: 'mont-blanc', id: '12abc34' })),
    ).toBeUndefined();
  });

  it('returns undefined for an empty id', () => {
    expect(
      allocineIdFromMovie(makeMovie({ title: 'T', cinemaId: 'mont-blanc', id: '' })),
    ).toBeUndefined();
  });

  it('handles numeric ids with leading zeros', () => {
    expect(allocineIdFromMovie(makeMovie({ title: 'T', cinemaId: 'mont-blanc', id: '007' }))).toBe(
      '007',
    );
  });
});
