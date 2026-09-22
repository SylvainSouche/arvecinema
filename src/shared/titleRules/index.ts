// ──────────────────────────────────────────────────────────────────────────
// Title cleaning — systematically strips cinema-event prefixes/suffixes
// from movie titles for deduplication + Wikidata search.
//
// Rules are language-specific (one file per language) and all languages
// are applied to every title (cinemas may use English labels in a
// French UI, e.g. "Avengers: Endgame Extended").
//
// The function returns both the cleaned title AND what was stripped,
// so the caller can:
//   1. Use the cleaned title for dedup/search
//   2. Retry with the original title if the cleaned version yields no
//      results (some films genuinely have "Extended" in their title)
//
// Usage:
//   import { cleanTitle } from '../shared/titleRules';
//   const { cleaned, stripped } = cleanTitle('En avant-première Heart Of The Beast');
//   // cleaned = "Heart Of The Beast", stripped = ['avant-premiere']
// ──────────────────────────────────────────────────────────────────────────

import type { TitleRule } from './types';
import { frRules } from './fr';
import { enRules } from './en';

// All rules, concatenated. We apply ALL language rules to every title
// because cinemas mix languages (French site with English movie titles).
const ALL_RULES: TitleRule[] = [...frRules, ...enRules];

export interface CleanedTitle {
  /** The cleaned title (prefixes/suffixes stripped). */
  cleaned: string;
  /** Names of the rules that matched (for debugging). Empty if nothing stripped. */
  stripped: string[];
  /** True if at least one rule matched (title was modified). */
  wasModified: boolean;
}

/** Normalize a string: lowercase + NFD accent removal + curly → straight
 *  apostrophes. Applied before rule matching so patterns don't need to
 *  handle accent variants. */
function preNormalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[\u2018\u2019\u201b]/g, "'")
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

/**
 * Clean a movie title by stripping cinema-event prefixes/suffixes.
 *
 * Applies all language rules (French + English) to every title, because
 * cinemas mix languages (e.g. a French cinema site showing "Avengers:
 * Endgame Extended" — the title is English, the site is French).
 *
 * @param title The raw movie title from the cinema API/HTML.
 * @returns The cleaned title + which rules matched.
 */
export function cleanTitle(title: string): CleanedTitle {
  const normalized = preNormalize(title);
  let cleaned = normalized;
  const stripped: string[] = [];

  for (const rule of ALL_RULES) {
    const before = cleaned;
    cleaned = cleaned.replace(rule.pattern, '').trim();
    if (cleaned !== before) {
      stripped.push(rule.name);
    }
  }

  // Collapse multiple spaces left by stripping
  cleaned = cleaned.replace(/\s+/g, ' ').trim();

  return {
    cleaned,
    stripped,
    wasModified: stripped.length > 0,
  };
}

/** Quick check: does the title contain any cleanable patterns? */
export function hasCleanablePatterns(title: string): boolean {
  const normalized = preNormalize(title);
  return ALL_RULES.some((rule) => rule.pattern.test(normalized));
}
