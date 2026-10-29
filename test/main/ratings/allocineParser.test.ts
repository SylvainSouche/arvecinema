// ──────────────────────────────────────────────────────────────────────────
// COVERAGE: Layer 3 — Parser contract tests for AlloCiné HTML scraping.
//
// Tests: extractRatingBySection, extractVoteCount
//
// Catches: Parser regressions from refactoring, CSS selector breakage when
//          AlloCiné changes their HTML structure, rating extraction logic
//          errors (wrong section, wrong CSS class pattern, etc.).
//
// Misses: Whether the AlloCiné website still returns the same HTML shape
//        (that's Layer 6 — live smoke tests). Does NOT test the fetch
//        mechanism (browserFetch, Cloudflare bypass) — only the parser.
//
// Fixtures: test/fixtures/allocine-matrix.html — a real AlloCiné film page
//          for "La Frappe" (cfilm=324170, press=4.0, audience=3.5).
//
// See TESTING.md for the full failure-mode → test-layer matrix.
// ──────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  extractRatingBySection,
  extractVoteCount,
  classifyAllocineHtml,
} from '../../../src/main/ratings/allocineClient';

// Load the real AlloCiné HTML fixture
const fixturePath = path.resolve(__dirname, '../../fixtures/allocine-matrix.html');
const fixtureHtml = fs.readFileSync(fixturePath, 'utf-8');

describe('AlloCiné parser — fixture: "La Frappe" (cfilm=324170)', () => {
  it('fixture loads and contains expected film title', () => {
    expect(fixtureHtml.length).toBeGreaterThan(10000);
    expect(fixtureHtml).toContain('La Frappe');
    expect(fixtureHtml).toContain('allocine');
  });

  it('extracts press rating from the "Presse" section', () => {
    const pressRating = extractRatingBySection(fixtureHtml, 'Presse');
    // stareval-note text = "3,9" → 3.9/5 (priority 1: more precise than CSS class)
    expect(pressRating).toBeDefined();
    expect(pressRating).toBe(3.9);
  });

  it('extracts audience rating from the "Spectateurs" section', () => {
    const audienceRating = extractRatingBySection(fixtureHtml, 'Spectateurs');
    // stareval-note text = "3,6" → 3.6/5 (priority 1: more precise than CSS class n35=3.5)
    expect(audienceRating).toBeDefined();
    expect(audienceRating).toBe(3.6);
  });

  it('extracts vote count from "NN Critiques Spectateurs" pattern', () => {
    const votes = extractVoteCount(fixtureHtml);
    expect(votes).toBeDefined();
    expect(votes).toBe(74);
  });
});

describe('AlloCiné parser — edge cases', () => {
  it('returns undefined when section label is not found', () => {
    expect(extractRatingBySection('<html></html>', 'Presse')).toBeUndefined();
    expect(extractRatingBySection(fixtureHtml, 'NonexistentSection')).toBeUndefined();
  });

  it('returns undefined for empty HTML', () => {
    expect(extractRatingBySection('', 'Presse')).toBeUndefined();
    expect(extractVoteCount('')).toBeUndefined();
  });

  it('handles Cloudflare challenge page gracefully', () => {
    const cloudflareHtml = '<html><body>Just a moment...</body></html>';
    expect(extractRatingBySection(cloudflareHtml, 'Presse')).toBeUndefined();
    expect(extractVoteCount(cloudflareHtml)).toBeUndefined();
  });

  it('extracts rating from rating-mdl CSS class', () => {
    const html = `
      <div>
        <span>Presse</span>
        <div class="rating-mdl n45 stareval-stars"></div>
      </div>
    `;
    expect(extractRatingBySection(html, 'Presse')).toBe(4.5);
  });

  it('extracts rating from stareval-note text (more precise)', () => {
    const html = `
      <div>
        <span>Presse</span>
        <span class="stareval-note">3,9</span>
      </div>
    `;
    expect(extractRatingBySection(html, 'Presse')).toBe(3.9);
  });

  it('extracts vote count from "NN Critiques Spectateurs"', () => {
    const html = '<div>74 Critiques Spectateurs</div>';
    expect(extractVoteCount(html)).toBe(74);
  });

  it('extracts vote count from "NN notes"', () => {
    const html = '<div>1 234 notes</div>';
    expect(extractVoteCount(html)).toBe(1234);
  });

  it('rejects ratings outside 0-5 range', () => {
    const html = `
      <div>
        <span>Presse</span>
        <div class="rating-mdl n99 stareval-stars"></div>
      </div>
    `;
    // n99 = 9.9 — outside 0-5 range, should be rejected
    expect(extractRatingBySection(html, 'Presse')).toBeUndefined();
  });
});

describe('AlloCiné page classification (degraded-response guard)', () => {
  // 2026-10-28: a burst of fichefilm requests came back 200 with the rating
  // widget stripped (bot mitigation). Recording that as 'absent' ("the film
  // has no ratings") poisoned the ratings cache — the classifier exists so
  // fetchAllocineRatings can tell the three cases apart.
  it('page with stareval markup → has-ratings', () => {
    expect(classifyAllocineHtml('<div class="stareval stareval-small">3,9</div>')).toBe('has-ratings');
  });

  it('CSS-only mention of stareval is NOT the widget (every page embeds the CSS)', () => {
    // Real case: cfilm=323550's stripped page contains exactly one 'stareval'
    // occurrence — inside the embedded <style> block. A bare-string check
    // would classify it has-ratings and record 'absent' again.
    const html = '<html><head><meta property="og:title" content="X"/>' +
      '<style>.entity-card .stareval-note{font-size:1rem}</style></head><body><p>synopsis</p></body></html>';
    expect(html).toContain('stareval'); // precondition: bare string present
    expect(classifyAllocineHtml(html)).toBe('valid-no-ratings');
  });

  it('genuine film page without rating cards → valid-no-ratings', () => {
    // Real case: "L'Affaire Marie-Claire" (cfilm=323550) — valid page, film
    // simply has no ratings yet.
    const html = '<html><head><meta property="og:title" content="L\'Affaire Marie-Claire"/>' +
      '<script type="application/ld+json">{"@type":"Movie"}</script></head><body><p>synopsis</p></body></html>';
    expect(classifyAllocineHtml(html)).toBe('valid-no-ratings');
  });

  it('challenge shell / interstitial → invalid-page (recorded as blocked, retryable)', () => {
    expect(classifyAllocineHtml('<html><body>Just a moment...</body></html>')).toBe('invalid-page');
    expect(classifyAllocineHtml('<html><body><div id="cf-challenge"></div></body></html>')).toBe('invalid-page');
    expect(classifyAllocineHtml('')).toBe('invalid-page');
  });
});
