// ──────────────────────────────────────────────────────────────────────────
// French title-cleaning rules — patterns that cinema websites prepend or
// append to movie titles that are NOT part of the actual film title.
//
// These are used to:
//   1. Deduplicate films across cinemas (e.g. "En avant-première X" == "X")
//   2. Clean titles before Wikidata search (e.g. "X Version longue" → "X")
//
// Each rule is a regex with a `name` for debugging + a `pattern` that
// matches the prefix or suffix to strip. The patterns are case-insensitive
// and accent-tolerant (the input is pre-normalized with NFD decomposition).
// ──────────────────────────────────────────────────────────────────────────

import type { TitleRule } from './types';

export const frRules: TitleRule[] = [
  // ── Prefixes: cinema event labels prepended to the title ──
  {
    name: 'avant-premiere',
    pattern: /^(en\s+)?avant[-\s]?premi[eè]re\s*[:\-]?\s*/i,
  },
  {
    name: 'soiree-speciale',
    pattern: /^soir[eé]e\s+sp[eé]ciale\s*[:\-]?\s*/i,
  },
  {
    name: 'seance-speciale',
    pattern: /^s[eé]ance\s+sp[eé]ciale\s*[:\-]?\s*/i,
  },
  {
    name: 'evenement-special',
    pattern: /^[eé]v[eé]nement\s+sp[eé]cial\s*[:\-]?\s*/i,
  },
  {
    name: 'en-avant-premiere',
    pattern: /^en\s+avant[-\s]?premi[eè]re\s+/i,
  },
  {
    name: 'exclusivite',
    pattern: /^exclusivit[eé]\s*[:\-]?\s*/i,
  },
  {
    name: 'nouveau',
    pattern: /^nouveau\s*[:\-]?\s*/i,
  },
  {
    name: 'nouveau-film',
    pattern: /^nouveau\s+film\s*[:\-]?\s*/i,
  },

  // ── Suffixes: version/edition labels appended after the title ──
  {
    name: 'version-longue',
    pattern: /\s+version\s+longue\s*$/i,
  },
  {
    name: 'version-courte',
    pattern: /\s+version\s+courte\s*$/i,
  },
  {
    name: 'version-integrale',
    pattern: /\s+version\s+int[eé]grale\s*$/i,
  },
  {
    name: 'version-restoree',
    pattern: /\s+version\s+restaur[eé]e\s*$/i,
  },
  {
    name: 'version-originale',
    pattern: /\s+version\s+originale\s*$/i,
  },
  {
    name: 'version-director-cut',
    pattern: /\s+version\s+director'?s?\s+cut\s*$/i,
  },
  {
    name: 'montage-director-cut',
    pattern: /\s+montage\s+director'?s?\s+cut\s*$/i,
  },
  {
    name: 'partie',
    // "Film - Partie 1", "Film : Partie 2 : Sous-titre"
    pattern: /\s*[-:]\s*partie\s+\d+\s*[:\-]?\s*/i,
  },
  {
    name: 'partie-suffix',
    // "Film Partie 1" (without separator)
    pattern: /\s+partie\s+\d+\s*$/i,
  },
  {
    name: 'copie-restoree',
    pattern: /\s+copie\s+restaur[eé]e\s*$/i,
  },
  {
    name: 'avant-premiere-suffix',
    pattern: /\s+avant[-\s]?premi[eè]re\s*$/i,
  },

  // ── Event suffixes (opera, concert, etc.) ──
  {
    name: 'metropolitan-opera',
    pattern: /\s*\([^)]*[mM]etropolitan\s*[oO]pera[^)]*\)\s*$/i,
  },
  {
    name: 'opera-paris',
    pattern: /\s*\([^)]*[oO]p[eé]ra\s+(?:de\s+)?[pP]aris[^)]*\)\s*$/i,
  },
  {
    name: 'opera-bastille',
    pattern: /\s*\([^)]*[bB]astille[^)]*\)\s*$/i,
  },
  {
    name: 'concert-film',
    pattern: /\s*\([^)]*concert[^)]*\)\s*$/i,
  },
  {
    name: 'retransmission',
    pattern: /\s*\([^)]*retransmission[^)]*\)\s*$/i,
  },
  {
    name: 'live',
    pattern: /\s*\([^)]*live[^)]*\)\s*$/i,
  },
  {
    name: 'en-direct',
    pattern: /\s*\([^)]*en\s+direct[^)]*\)\s*$/i,
  },
  {
    name: 'captcha-cinema',
    pattern: /\s*\([^)]*captation[^)]*\)\s*$/i,
  },
];
