// ──────────────────────────────────────────────────────────────────────────
// English title-cleaning rules — same structure as fr.ts.
// ──────────────────────────────────────────────────────────────────────────

import type { TitleRule } from './types';

export const enRules: TitleRule[] = [
  // ── Prefixes ──
  {
    name: 'advance-screening',
    pattern: /^(advance\s+screening|preview)\s*[:\-]?\s*/i,
  },
  {
    name: 'special-screening',
    pattern: /^special\s+(screening|showing|event)\s*[:\-]?\s*/i,
  },
  {
    name: 'exclusive',
    pattern: /^exclusive\s*[:\-]?\s*/i,
  },
  {
    name: 'limited-engagement',
    pattern: /^limited\s+engagement\s*[:\-]?\s*/i,
  },
  {
    name: 'one-night-only',
    pattern: /^one\s+night\s+only\s*[:\-]?\s*/i,
  },

  // ── Suffixes ──
  {
    name: 'extended',
    pattern: /\s+extended\s*$/i,
  },
  {
    name: 'extended-cut',
    pattern: /\s+extended\s+cut\s*$/i,
  },
  {
    name: 'extended-edition',
    pattern: /\s+extended\s+edition\s*$/i,
  },
  {
    name: 'remastered',
    pattern: /\s+remastered\s*$/i,
  },
  {
    name: 'remaster',
    pattern: /\s+remaster(ed)?\s+(cut|edition|version)?\s*$/i,
  },
  {
    name: 'directors-cut',
    pattern: /\s+director'?s?\s+cut\s*$/i,
  },
  {
    name: 'final-cut',
    pattern: /\s+final\s+cut\s*$/i,
  },
  {
    name: 'ultimate-edition',
    pattern: /\s+ultimate\s+edition\s*$/i,
  },
  {
    name: 'uncut',
    pattern: /\s+uncut\s*$/i,
  },
  {
    name: 'unrated',
    pattern: /\s+unrated\s*$/i,
  },
  {
    name: 'imax',
    pattern: /\s+imax\s*$/i,
  },
  {
    name: '3d',
    pattern: /\s+3d\s*$/i,
  },
  {
    name: '4k',
    pattern: /\s+4k\s+(restoration|remaster|edition)?\s*$/i,
  },
  {
    name: 'part',
    pattern: /\s*[-:]\s*part\s+\d+\s*[:\-]?\s*/i,
  },
  {
    name: 'part-suffix',
    pattern: /\s+part\s+\d+\s*$/i,
  },

  // ── Event suffixes ──
  {
    name: 'met-opera',
    pattern: /\s*\([^)]*(met|metropolitan)\s*opera[^)]*\)\s*$/i,
  },
  {
    name: 'live-concert',
    pattern: /\s*\([^)]*(live|concert)[^)]*\)\s*$/i,
  },
  {
    name: 'in-theaters',
    pattern: /\s*\([^)]*in\s+(theaters|cinemas?)[^)]*\)\s*$/i,
  },
  {
    name: 'live-broadcast',
    pattern: /\s*\([^)]*(broadcast|streaming)[^)]*\)\s*$/i,
  },
];
