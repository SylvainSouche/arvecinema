// ──────────────────────────────────────────────────────────────────────────
// COVERAGE: Layer 1 — Unit tests for systematic title-cleaning rules.
//
// Tests: cleanTitle() with French + English patterns
//
// Catches: Missing patterns for cinema-event labels that prevent
//          deduplication or break Wikidata title search.
//
// Misses: Whether the rules match real cinema data (that's Layer 3 —
//        parser contract tests with real fixtures). Does NOT test
//        the retry-without-stripping logic in findByTitle() (that's
//        an integration test concern).
//
// See TESTING.md for the full failure-mode → test-layer matrix.
// ──────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from 'vitest';
import { cleanTitle, hasCleanablePatterns } from '../../src/shared/titleRules';

describe('Title cleaning — French prefixes', () => {
  it('strips "En avant-première" prefix', () => {
    const r = cleanTitle('En avant-première Heart Of The Beast');
    expect(r.cleaned).toBe('heart of the beast');
    expect(r.stripped).toContain('avant-premiere');
    expect(r.wasModified).toBe(true);
  });

  it('strips "Avant-première :" prefix', () => {
    const r = cleanTitle('Avant-première : Spider-Man');
    expect(r.cleaned).toBe('spider-man');
    expect(r.wasModified).toBe(true);
  });

  it('strips "Avant-première" prefix (without colon)', () => {
    const r = cleanTitle('Avant-première Spider-Man');
    expect(r.cleaned).toBe('spider-man');
  });

  it('strips "Soirée spéciale" prefix', () => {
    const r = cleanTitle('Soirée spéciale : Le Film');
    expect(r.cleaned).toBe('le film');
  });

  it('strips "Séance spéciale" prefix', () => {
    const r = cleanTitle('Séance spéciale : Le Film');
    expect(r.cleaned).toBe('le film');
  });

  it('strips "Événement spécial" prefix', () => {
    const r = cleanTitle('Événement spécial : Le Film');
    expect(r.cleaned).toBe('le film');
  });

  it('strips "Exclusivité" prefix', () => {
    const r = cleanTitle('Exclusivité : Le Film');
    expect(r.cleaned).toBe('le film');
  });
});

describe('Title cleaning — French suffixes', () => {
  it('strips "Version longue" suffix', () => {
    const r = cleanTitle('Film Version longue');
    expect(r.cleaned).toBe('film');
  });

  it('strips "Version courte" suffix', () => {
    const r = cleanTitle('Film Version courte');
    expect(r.cleaned).toBe('film');
  });

  it('strips "Version intégrale" suffix', () => {
    const r = cleanTitle('Film Version intégrale');
    expect(r.cleaned).toBe('film');
  });

  it('strips "Version restaurée" suffix', () => {
    const r = cleanTitle('Film Version restaurée');
    expect(r.cleaned).toBe('film');
  });

  it('strips "Copie restaurée" suffix', () => {
    const r = cleanTitle('Film Copie restaurée');
    expect(r.cleaned).toBe('film');
  });

  it('strips "Partie N" with separator', () => {
    const r = cleanTitle('Film - Partie 1 : Sous-titre');
    expect(r.wasModified).toBe(true);
    expect(r.stripped).toContain('partie');
    expect(r.cleaned).toContain('film');
  });

  it('strips "Partie N" without separator', () => {
    const r = cleanTitle('Film Partie 1');
    expect(r.cleaned).toBe('film');
  });

  it('strips "Avant-première" suffix', () => {
    const r = cleanTitle('Film avant-première');
    expect(r.cleaned).toBe('film');
  });
});

describe('Title cleaning — English prefixes', () => {
  it('strips "Advance screening" prefix', () => {
    const r = cleanTitle('Advance screening: The Matrix');
    expect(r.cleaned).toBe('the matrix');
  });

  it('strips "Preview" prefix', () => {
    const r = cleanTitle('Preview: The Matrix');
    expect(r.cleaned).toBe('the matrix');
  });

  it('strips "Special screening" prefix', () => {
    const r = cleanTitle('Special screening: The Matrix');
    expect(r.cleaned).toBe('the matrix');
  });

  it('strips "One night only" prefix', () => {
    const r = cleanTitle('One night only: The Matrix');
    expect(r.cleaned).toBe('the matrix');
  });
});

describe('Title cleaning — English suffixes', () => {
  it('strips "Extended" suffix', () => {
    const r = cleanTitle('Avengers Endgame Extended');
    expect(r.cleaned).toBe('avengers endgame');
  });

  it('strips "Extended Cut" suffix', () => {
    const r = cleanTitle('Avengers Endgame Extended Cut');
    expect(r.cleaned).toBe('avengers endgame');
  });

  it('strips "Extended Edition" suffix', () => {
    const r = cleanTitle('Avengers Endgame Extended Edition');
    expect(r.cleaned).toBe('avengers endgame');
  });

  it('strips "Remastered" suffix', () => {
    const r = cleanTitle('Blade Runner Remastered');
    expect(r.cleaned).toBe('blade runner');
  });

  it('strips "Director\'s Cut" suffix', () => {
    const r = cleanTitle("Blade Runner Director's Cut");
    expect(r.cleaned).toBe('blade runner');
  });

  it('strips "Directors Cut" suffix (no apostrophe)', () => {
    const r = cleanTitle('Blade Runner Directors Cut');
    expect(r.cleaned).toBe('blade runner');
  });

  it('strips "Final Cut" suffix', () => {
    const r = cleanTitle('Blade Runner Final Cut');
    expect(r.cleaned).toBe('blade runner');
  });

  it('strips "Ultimate Edition" suffix', () => {
    const r = cleanTitle('Batman v Superman Ultimate Edition');
    expect(r.cleaned).toBe('batman v superman');
  });

  it('strips "Uncut" suffix', () => {
    const r = cleanTitle('The Film Uncut');
    expect(r.cleaned).toBe('the film');
  });

  it('strips "Unrated" suffix', () => {
    const r = cleanTitle('The Film Unrated');
    expect(r.cleaned).toBe('the film');
  });

  it('strips "4K Restoration" suffix', () => {
    const r = cleanTitle('Lawrence of Arabia 4K Restoration');
    expect(r.cleaned).toBe('lawrence of arabia');
  });

  it('strips "3D" suffix', () => {
    const r = cleanTitle('Avatar 3D');
    expect(r.cleaned).toBe('avatar');
  });

  it('strips "IMAX" suffix', () => {
    const r = cleanTitle('Dune IMAX');
    expect(r.cleaned).toBe('dune');
  });

  it('strips "Part N" with separator', () => {
    const r = cleanTitle('Film - Part 1: Subtitle');
    expect(r.wasModified).toBe(true);
    expect(r.stripped).toContain('part');
    // The part rule strips "- Part 1 : " leaving "Film" + "Subtitle"
    // (they get concatenated without a separator since the rule eats it)
    expect(r.cleaned).toContain('film');
  });

  it('strips "Part N" without separator', () => {
    const r = cleanTitle('Film Part 1');
    expect(r.cleaned).toBe('film');
  });
});

describe('Title cleaning — event suffixes (opera, concert, live)', () => {
  it('strips "(Metropolitan Opera)" suffix', () => {
    const r = cleanTitle('Così fan tutte (Metropolitan Opera)');
    expect(r.cleaned).toBe('cosi fan tutte');
  });

  it('strips "(Opéra de Paris)" suffix', () => {
    const r = cleanTitle('La Bohème (Opéra de Paris)');
    expect(r.cleaned).toBe('la boheme');
  });

  it('strips "(Bastille)" suffix', () => {
    const r = cleanTitle('La Bohème (Bastille)');
    expect(r.cleaned).toBe('la boheme');
  });

  it('strips "(concert)" suffix', () => {
    const r = cleanTitle('The Concert (concert)');
    expect(r.cleaned).toBe('the concert');
  });

  it('strips "(live)" suffix', () => {
    const r = cleanTitle('The Show (live)');
    expect(r.cleaned).toBe('the show');
  });

  it('strips "(en direct)" suffix', () => {
    const r = cleanTitle('The Show (en direct)');
    expect(r.cleaned).toBe('the show');
  });

  it('strips "(retransmission)" suffix', () => {
    const r = cleanTitle('The Show (retransmission)');
    expect(r.cleaned).toBe('the show');
  });

  it('strips "(captation)" suffix', () => {
    const r = cleanTitle('The Show (captation)');
    expect(r.cleaned).toBe('the show');
  });
});

describe('Title cleaning — no false positives', () => {
  it('does not strip anything from a plain title', () => {
    const r = cleanTitle('The Matrix');
    expect(r.cleaned).toBe('the matrix');
    expect(r.wasModified).toBe(false);
    expect(r.stripped).toHaveLength(0);
  });

  it('does not strip "Extended" from the start of a title', () => {
    // "Extended" at the start is part of the title, not a suffix.
    // Our suffix rules use `$` anchor — they only match at the end.
    const r = cleanTitle('Extended Family');
    expect(r.wasModified).toBe(false);
    expect(r.cleaned).toBe('extended family');
  });

  it('does not strip "Final Cut" when it IS the title', () => {
    // "Final Cut" as the entire title — the suffix regex `\s+final\s+cut\s*$`
    // requires at least one space before "final", so it doesn't match
    // when "Final Cut" IS the title (no leading space).
    // This is correct — the retry logic in findByTitle() isn't even needed here.
    const r = cleanTitle('Final Cut');
    expect(r.wasModified).toBe(false);
    expect(r.cleaned).toBe('final cut');
  });

  it('handles empty string', () => {
    const r = cleanTitle('');
    expect(r.cleaned).toBe('');
    expect(r.wasModified).toBe(false);
  });
});

describe('Title cleaning — multiple patterns', () => {
  it('strips both prefix and suffix', () => {
    const r = cleanTitle('En avant-première Avengers Endgame Extended');
    expect(r.cleaned).toBe('avengers endgame');
    expect(r.stripped.length).toBeGreaterThanOrEqual(2);
  });

  it('strips prefix + event suffix', () => {
    const r = cleanTitle('Avant-première Così fan tutte (Metropolitan Opera)');
    expect(r.cleaned).toBe('cosi fan tutte');
  });
});

describe('hasCleanablePatterns', () => {
  it('returns true for titles with cleanable patterns', () => {
    expect(hasCleanablePatterns('En avant-première Film')).toBe(true);
    expect(hasCleanablePatterns('Film Extended')).toBe(true);
    expect(hasCleanablePatterns('Film (Metropolitan Opera)')).toBe(true);
  });

  it('returns false for plain titles', () => {
    expect(hasCleanablePatterns('The Matrix')).toBe(false);
    expect(hasCleanablePatterns('')).toBe(false);
  });
});
