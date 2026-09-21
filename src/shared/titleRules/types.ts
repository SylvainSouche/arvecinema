// ──────────────────────────────────────────────────────────────────────────
// Title cleaning rule — a named regex pattern that strips cinema-event
// prefixes/suffixes from movie titles.
//
// `name` is used for debugging ("stripped 'avant-premiere' from 'En
// avant-première Heart Of The Beast'").
//
// `pattern` is a RegExp that matches the prefix (^) or suffix ($) to
// strip. It should be case-insensitive and accent-tolerant (the input
// is pre-normalized with NFD decomposition before rules are applied).
// ──────────────────────────────────────────────────────────────────────────

export interface TitleRule {
  /** Human-readable name for debugging — e.g. 'avant-premiere', 'extended' */
  name: string;
  /** Regex matching the prefix (^) or suffix ($) to strip. */
  pattern: RegExp;
}
