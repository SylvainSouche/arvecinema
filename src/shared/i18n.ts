// ──────────────────────────────────────────────────────────────────────────
// Internationalization (i18n) — all UI strings in one place.
//
// Translation data lives in per-language JSON files next to this module
// (fr.json, en.json) so non-dev contributors can edit strings without
// touching TypeScript. The key list below (KEYS) is the SINGLE SOURCE OF
// TRUTH for the key set: the TranslationKey union is derived from it via
// `typeof KEYS[number]`, and a runtime completeness check asserts both
// JSON files define every key (fails loudly in tests, falls back to the
// key string in production — never crashes the UI).
//
// To add a new language:
//   1. Add a key to the `Locale` type
//   2. Create an <locale>.json file in src/shared/i18n/
//   3. Register it in TRANSLATIONS_SOURCES + VALID_LOCALES below
//
// Usage in components:
//   import { t, useLocale } from '../../shared/i18n';
//   const { locale, setLocale } = useLocale();
//   <button>{t('refresh')}</button>
//
// `useLocale()` is a React hook that persists the locale to localStorage
// and triggers a re-render when it changes.
// ──────────────────────────────────────────────────────────────────────────

import { useState, useEffect, useCallback } from 'react';
import frTable from './i18n/fr.json';
import enTable from './i18n/en.json';

export type Locale = 'fr' | 'en';

/** All translation keys. Adding a key here without adding it to
 *  fr.json/en.json fails the i18n contract test (test/shared/i18nContract.test.ts). */
export const KEYS = [
  // ── App shell / filters / sort ─────────────────────────────────────────
  'appTitle',
  'loading',
  'error',
  'noResults',
  'noShowtimes',
  'allCinemas',
  'cinema',
  'allDays',
  'allVersions',
  'vf',
  'vo',
  'hourRange',
  'sortBy',
  'sort_nextScreening',
  'sort_title',
  'sort_cinema',
  'dayView',
  'weekView',
  'refresh',
  'refreshTooltip',
  'themeToggle_dark',
  'themeToggle_light',
  'updated',
  'films',
  'film',
  'cinemas',
  'cinema_singular',
  'week',
  'realization',
  'with_',
  'noPoster',
  'noRatingsFound',
  'screen',
  'version',
  'unspecified',
  'minutes',
  'pressRating',
  'audienceRating',
  'votes',
  'vote',
  'imdbRating',
  'ratingLabel',
  'openImdb',
  'openAllocine',
  'openRt',
  'certifiedFresh',
  'rottenTomatoes',
  'ratingAbsent',
  'ratingBlocked',
  'ratingPending',
  'retryFailed',
  'retryFailedTooltip',
  'retryInProgress',
  'retryDone',
  'invalidateCache',
  'invalidateCacheTooltip',
  'invalidateCacheConfirm',
  'invalidateCacheDone',
  'searchPlaceholder',
  'today',
  'language',
  'french',
  'english',
  'noSessions',
  // ── Generic UI labels (shared across components) ───────────────────────
  'clear',
  'export',
  'autoScroll',
  'allComponents',
  'filterMessages',
  'noLogEntries',
  'logAll',
  'minHour',
  'maxHour',
  // ── Error boundary ──────────────────────────────────────────────────────
  'errorBoundaryTitle',
  'errorBoundaryMessage',
  'reload',
  // ── Cinema status banner ────────────────────────────────────────────────
  'cinemaStatus_timeout',
  'cinemaStatus_http-error',
  'cinemaStatus_parse-error',
  'cinemaUnavailable',
  // ── Progress bar ────────────────────────────────────────────────────────
  'ratingsProgress',
  // ── Diagnostics panel ───────────────────────────────────────────────────
  'diagnostics',
  'diagnosticsTitle',
  'diagnosticsCinemas',
  'diagnosticsRatingSources',
  'diagnosticsBlockedFilms',
  'diagnosticsCopy',
  'diagnosticsCopied',
  'diagnosticsReportIssue',
  'diagnosticsNoBlocked',
  'diagnosticsNetworkActive',
  'diagnosticsNetworkIdle',
  'diagnosticsMoviesLoaded',
  'diagnosticsLastLogs',
  // ── About panel ─────────────────────────────────────────────────────────
  'about',
  'aboutTitle',
  'close',
  'aboutLicense',
  'aboutLicenseIntro',
  'aboutDependencies',
  'aboutDependenciesIntro',
  'aboutAttributions',
  'aboutPersonalUse',
  'aboutPersonalUseDescription',
  'aboutImdbDescription',
  'aboutWikidataDescription',
  // ── Custom cinemas settings ─────────────────────────────────────────────
  'customCinemasTab',
  'customCinemasTitle',
  'customCinemasHint',
  'customCinemasEmpty',
  'customCinemasAdd',
  'customCinemasRemove',
  'customCinemasSave',
  'customCinemasSaved',
  'customCinemasSaveError',
  'customCinemaName',
  'customCinemaCity',
  'customCinemaColor',
  'customCinemaKind',
  'customCinemaBaseUrl',
  'customCinemaTheaterId',
  'customCinemasRegistered',
] as const;

/** Translation table keys, derived from KEYS (single source of truth). */
export type TranslationKey = (typeof KEYS)[number];

type Translation = { fr: string; en: string };
const UNKNOWN_TABLE_KEYS = new Set<string>();

/** Per-language string tables (JSON, editable by non-devs). */
const TABLES: Record<Locale, Record<string, string>> = {
  fr: frTable as Record<string, string>,
  en: enTable as Record<string, string>,
};

/** Build the merged TRANSLATIONS table from the JSON sources. Missing keys
 *  (key in KEYS but absent from a JSON file) are recorded in
 *  UNKNOWN_TABLE_KEYS so tests can fail loudly, while the runtime fallback
 *  chain in t() keeps the UI functional (renders the key string). */
function buildTranslations(): Partial<Record<TranslationKey, Translation>> {
  const merged: Partial<Record<TranslationKey, Translation>> = {};
  for (const key of KEYS) {
    const fr = TABLES.fr[key];
    const en = TABLES.en[key];
    if (fr === undefined || en === undefined) {
      UNKNOWN_TABLE_KEYS.add(key);
      continue;
    }
    merged[key] = { fr, en };
  }
  return merged;
}

export const TRANSLATIONS: Partial<Record<TranslationKey, Translation>> = buildTranslations();

/** Keys declared in KEYS but missing from at least one locale file — must
 *  be empty in a healthy tree. Exported for the contract test. */
export function missingTranslationKeys(): string[] {
  return [...UNKNOWN_TABLE_KEYS];
}

/** Locale JSON files that exist — for the language picker + tests. */
export const VALID_LOCALES: readonly Locale[] = ['fr', 'en'];

export const DEFAULT_LOCALE: Locale = 'fr';
const STORAGE_KEY = 'arvecinema-locale';

// ── Locale storage ─────────────────────────────────────────────────────────

let currentLocale: Locale = (() => {
  try {
    return (localStorage.getItem(STORAGE_KEY) as Locale) ?? DEFAULT_LOCALE;
  } catch {
    return DEFAULT_LOCALE;
  }
})();

const listeners = new Set<() => void>();

export function getLocale(): Locale {
  return currentLocale;
}

export function setLocale(locale: Locale): void {
  currentLocale = locale;
  try {
    localStorage.setItem(STORAGE_KEY, locale);
  } catch {
    /* ignore */
  }
  listeners.forEach((fn) => fn());
}

/** Translate a key using the current locale.
 *
 *  Fallback chain: current locale → French (DEFAULT_LOCALE) → key string.
 *  This ensures a missing translation never crashes the UI — the worst
 *  case is a French string shown to an English user (or vice versa). */
export function t(key: TranslationKey): string {
  const entry = TRANSLATIONS[key];
  if (!entry) return key;
  // Try current locale first, then fall back to French (the project's
  // original language — most complete coverage), then to the key itself.
  return entry[currentLocale] ?? entry[DEFAULT_LOCALE] ?? entry.fr ?? key;
}

/** Translate a key with a specific locale (bypasses the global state). */
export function tIn(key: TranslationKey, locale: Locale): string {
  const entry = TRANSLATIONS[key];
  if (!entry) return key;
  return entry[locale] ?? entry[DEFAULT_LOCALE] ?? entry.fr ?? key;
}

/** Translate a key with parameter substitution.
 *
 *  Replaces `{name}` placeholders in the translation string with values
 *  from the `params` object.
 *
 *  Example:
 *    tFmt('retryDone', { recovered: 3, retried: 5 })
 *    → fr: "3 récupérée(s) sur 5"
 *    → en: "3 of 5 recovered"
 */
export function tFmt(key: TranslationKey, params: Record<string, string | number>): string {
  let s = t(key);
  for (const [k, v] of Object.entries(params)) {
    s = s.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v));
  }
  return s;
}

/** Format a number using the current locale's decimal separator.
 *  - fr: `3.5` → `"3,5"`  (comma)
 *  - en: `3.5` → `"3.5"`  (dot)
 *
 *  Used for AlloCiné ratings which are natively on a 0-5 scale with a
 *  French-style decimal separator. */
export function formatDecimal(n: number, fractionDigits = 1): string {
  return n.toLocaleString(currentLocale === 'fr' ? 'fr-FR' : 'en-US', {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  });
}

// ── React hook ──────────────────────────────────────────────────────────────

/** React hook that subscribes to locale changes and triggers re-renders. */
export function useLocale(): {
  locale: Locale;
  setLocale: (l: Locale) => void;
  t: (k: TranslationKey) => string;
} {
  const [, setTick] = useState(0);

  useEffect(() => {
    const fn = () => setTick((n) => n + 1);
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  }, []);

  const changeLocale = useCallback((l: Locale) => setLocale(l), []);

  return { locale: currentLocale, setLocale: changeLocale, t };
}
