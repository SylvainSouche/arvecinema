// ──────────────────────────────────────────────────────────────────────────
// COVERAGE: Layer 1 — Unit tests for VF/VO audio filter detection.
//
// Tests: isVFShowtime, isVOShowtime, showtimeVersion
//
// Catches: Logic bugs in audio version classification — would either
//          hide VF screenings from French users or show dubbed versions
//          to users who want VO.
//
// Misses: Whether the tag strings from Box Office API are still the same
//        (that's a live smoke test concern). Only tests the logic given
//        known tag strings.
//
// See TESTING.md for the full failure-mode → test-layer matrix.
// ──────────────────────────────────────────────────────────────────────────
// ──────────────────────────────────────────────────────────────────────────
// Unit tests for src/shared/types.ts — VF/VO detection helpers.
//
// These functions decide which showtimes match the user's "VF" / "VO" /
// "All" filter. A regression here would either hide VF screenings from
// French-speaking users, or show dubbed versions to users who want VO.
// ──────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from 'vitest';
import { isVFShowtime, isVOShowtime, showtimeVersion } from '../../src/shared/types';

// Real tag strings from the Box Office API (verified from production data).
const VF_TAGS = ['Localization.Language.French'];
const VO_TAGS = ['Localization.Version.Original'];
const DUBBED_TAGS = ['Showtime.Accessibility.Dubbed'];
const VF_AND_VO_TAGS = ['Localization.Language.French', 'Localization.Version.Original'];
const UNRELATED_TAGS = ['Showtime.Format.3D', 'Some.Other.Tag'];
const EMPTY_TAGS: string[] = [];

// ── isVFShowtime ────────────────────────────────────────────────────────────

describe('isVFShowtime', () => {
  it('returns true for Localization.Language.French', () => {
    expect(isVFShowtime(VF_TAGS)).toBe(true);
  });

  it('returns true for Showtime.Accessibility.Dubbed (audio-described)', () => {
    expect(isVFShowtime(DUBBED_TAGS)).toBe(true);
  });

  it('returns false for VO-only tags', () => {
    expect(isVFShowtime(VO_TAGS)).toBe(false);
  });

  it('returns true when both VF and VO tags are present (multi-format screening)', () => {
    expect(isVFShowtime(VF_AND_VO_TAGS)).toBe(true);
  });

  it('returns false for unrelated tags', () => {
    expect(isVFShowtime(UNRELATED_TAGS)).toBe(false);
  });

  it('returns false for empty tags', () => {
    expect(isVFShowtime(EMPTY_TAGS)).toBe(false);
  });
});

// ── isVOShowtime ─────────────────────────────────────────────────────────────

describe('isVOShowtime', () => {
  it('returns true for Localization.Version.Original', () => {
    expect(isVOShowtime(VO_TAGS)).toBe(true);
  });

  it('returns false for VF-only tags', () => {
    expect(isVOShowtime(VF_TAGS)).toBe(false);
  });

  it('returns false for dubbed (dubbed ≠ original version)', () => {
    expect(isVOShowtime(DUBBED_TAGS)).toBe(false);
  });

  it('returns true when both VF and VO tags are present', () => {
    expect(isVOShowtime(VF_AND_VO_TAGS)).toBe(true);
  });

  it('returns false for unrelated tags', () => {
    expect(isVOShowtime(UNRELATED_TAGS)).toBe(false);
  });

  it('returns false for empty tags', () => {
    expect(isVOShowtime(EMPTY_TAGS)).toBe(false);
  });
});

// ── showtimeVersion ──────────────────────────────────────────────────────────

describe('showtimeVersion', () => {
  it('returns "VO" when only VO tags are present', () => {
    expect(showtimeVersion(VO_TAGS)).toBe('VO');
  });

  it('returns "VF" when only VF tags are present', () => {
    expect(showtimeVersion(VF_TAGS)).toBe('VF');
  });

  it('returns "VF" when only dubbed tags are present', () => {
    expect(showtimeVersion(DUBBED_TAGS)).toBe('VF');
  });

  it('returns "VO" when both VF and VO tags are present (VO takes priority)', () => {
    // Per the implementation: `isVOShowtime(tags) ? 'VO' : isVFShowtime(tags) ? 'VF' : ''`
    // VO check comes first — so a mixed screening is labeled "VO".
    expect(showtimeVersion(VF_AND_VO_TAGS)).toBe('VO');
  });

  it('returns empty string for unrelated tags', () => {
    expect(showtimeVersion(UNRELATED_TAGS)).toBe('');
  });

  it('returns empty string for empty tags', () => {
    expect(showtimeVersion(EMPTY_TAGS)).toBe('');
  });

  it('returns a value suitable for display (never undefined)', () => {
    expect(typeof showtimeVersion(VO_TAGS)).toBe('string');
    expect(showtimeVersion(VO_TAGS)).toHaveLength(2);
    expect(showtimeVersion(EMPTY_TAGS)).toHaveLength(0);
  });
});
