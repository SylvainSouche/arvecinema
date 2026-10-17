// ──────────────────────────────────────────────────────────────────────────
// i18n contract tests — structural invariants that keep translations sane.
//
// Replaces scripts/smoke-test-i18n.mjs (migrated to vitest so it runs with
// `npm test` in CI instead of as a separate fragile grep step).
//
// Where the old script grepped source text, these tests compile real
// modules where possible:
//   - KEYS ↔ fr.json ↔ en.json completeness: real JSON imports + the
//     runtime missingTranslationKeys() accessor (no regex needed)
//   - no STALE keys in the JSON files (drift detection — the old script
//     couldn't see this direction)
//   - hardcoded aria-label/placeholder/title literals in renderer
//     components: kept as a source audit (it greps by design)
//   - the fallback chain and parameter substitution are BEHAVIORAL and
//     already covered by i18n.test.ts — not duplicated here.
//
// What this catches:
//   - a key added to KEYS but forgotten in a JSON file (or vice versa)
//   - a key renamed in i18n.ts with the old key left stale in JSON
//   - a hardcoded UI string sneaking past t()
// ──────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  KEYS,
  TRANSLATIONS,
  VALID_LOCALES,
  DEFAULT_LOCALE,
  missingTranslationKeys,
} from '../../src/shared/i18n';
import frTable from '../../src/shared/i18n/fr.json';
import enTable from '../../src/shared/i18n/en.json';

// ── KEYS ↔ JSON file completeness ─────────────────────────────────────────

describe('i18n contract: KEYS ↔ JSON tables', () => {
  it('KEYS exists and is substantial (the whole UI strings set)', () => {
    expect(KEYS.length).toBeGreaterThan(50);
  });

  it('every key in KEYS exists in BOTH fr.json and en.json', () => {
    expect(missingTranslationKeys()).toEqual([]);
    // Double-check directly against the raw JSON — independent of the
    // runtime builder used by missingTranslationKeys().
    for (const key of KEYS) {
      expect(frTable).toHaveProperty(key);
      expect(enTable).toHaveProperty(key);
    }
  });

  it('no stale keys: every JSON key is declared in KEYS (drift detection)', () => {
    const keySet = new Set<string>(KEYS);
    for (const table of [frTable, enTable]) {
      const stale = Object.keys(table).filter((k) => !keySet.has(k));
      expect(stale).toEqual([]); // e.g. a renamed key left behind in JSON
    }
  });

  it('TRANSLATIONS covers exactly KEYS (the runtime table is complete)', () => {
    expect(Object.keys(TRANSLATIONS).length).toBe(KEYS.length);
  });

  it('JSON values are plain non-empty strings (no objects leaked in)', () => {
    for (const table of [frTable, enTable]) {
      for (const value of Object.values(table)) {
        expect(typeof value).toBe('string');
        expect(value.length).toBeGreaterThan(0);
      }
    }
  });

  it('every declared locale has a JSON table + VALID_LOCALES matches imports', () => {
    for (const locale of VALID_LOCALES) {
      const file = path.join(process.cwd(), 'src/shared/i18n', `${locale}.json`);
      expect(fs.existsSync(file)).toBe(true);
    }
  });

  it('DEFAULT_LOCALE is one of the valid locales', () => {
    expect(VALID_LOCALES).toContain(DEFAULT_LOCALE);
  });
});

// ── Hardcoded UI string audit (source-level, ported from the mjs script) ──

describe('i18n contract: no hardcoded UI strings in components', () => {
  const IGNORE_FILES = ['ExportButton.tsx']; // dev-only — English is acceptable
  const ALLOWED_LITERAL_PATTERNS = [
    /^[\w-]+$/, // filenames, CSS class names, technical identifiers
    /^.$/, // single chars (icons etc.)
    /^$/, // empty string
  ];

  function walk(dir: string): string[] {
    const out: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) out.push(...walk(p));
      else if (entry.name.endsWith('.tsx')) out.push(p);
    }
    return out;
  }

  it('no hardcoded aria-label/placeholder/title literals in components', () => {
    const componentsDir = path.join(process.cwd(), 'src/renderer/components');
    const violations: string[] = [];
    for (const file of walk(componentsDir)) {
      const rel = path.relative(process.cwd(), file);
      if (IGNORE_FILES.some((ignored) => rel.endsWith(ignored))) continue;
      const src = fs.readFileSync(file, 'utf8');
      const stripped = src
        .replace(/\/\/[^\n]*/g, '') // line comments
        .replace(/\/\*[\s\S]*?\*\//g, '') // block comments
        .replace(/`(?:\\.|[^`\\])*`/g, '``'); // template literals
      for (const m of stripped.matchAll(/(?:aria-label|placeholder|title)="([^"]+)"/g)) {
        const val = m[1];
        if (ALLOWED_LITERAL_PATTERNS.some((p) => p.test(val))) continue;
        if (/^\p{Emoji}+$/u.test(val)) continue; // emoji-only icons
        violations.push(`${rel}: hardcoded "${val}" (use t() or tFmt())`);
      }
    }
    expect(violations).toEqual([]);
  });
});

// ── Add-a-language readiness ─────────────────────────────────────────────
// (When adding e.g. 'de': Locale type + VALID_LOCALES + de.json are all
// needed; the componentsDir walk + these tests catch a missed piece.)

describe('i18n contract: locale plumbing consistency', () => {
  it('Locale type values and VALID_LOCALES stay in sync with the JSON files', () => {
    // Type-level sync is guaranteed by the Locale typing of VALID_LOCALES,
    // but a NEW locale needs a JSON file too — this asserts 1:1.
    const files = fs
      .readdirSync(path.join(process.cwd(), 'src/shared/i18n'))
      .filter((f) => /^[a-z]{2}(-[A-Z]{2})?\.json$/.test(f)) // fr.json, en.json, de-DE.json…
      .map((f) => f.replace('.json', ''));
    expect([...VALID_LOCALES].sort()).toEqual(files.sort());
  });
});
