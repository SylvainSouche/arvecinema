// ──────────────────────────────────────────────────────────────────────────
// Internationalization (i18n) — all UI strings in one place.
//
// To add a new language:
//   1. Add a key to the `Locale` type
//   2. Add a translations object to `TRANSLATIONS`
//   3. Set the default locale (or read from localStorage at startup)
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

export type Locale = 'fr' | 'en';

export const DEFAULT_LOCALE: Locale = 'fr';
const STORAGE_KEY = 'arvecinema-locale';

/** Translation table. Each key maps to { fr: string, en: string }. */
export type TranslationKey =
  | 'appTitle'
  | 'loading'
  | 'error'
  | 'noResults'
  | 'noShowtimes'
  | 'allCinemas'
  | 'cinema'
  | 'allDays'
  | 'allVersions'
  | 'vf'
  | 'vo'
  | 'hourRange'
  | 'sortBy'
  | 'sort_nextScreening'
  | 'sort_title'
  | 'sort_cinema'
  | 'dayView'
  | 'weekView'
  | 'refresh'
  | 'refreshTooltip'
  | 'themeToggle_dark'
  | 'themeToggle_light'
  | 'updated'
  | 'films'
  | 'film'
  | 'cinemas'
  | 'cinema_singular'
  | 'week'
  | 'realization'
  | 'with_'
  | 'noPoster'
  | 'noRatingsFound'
  | 'screen'
  | 'version'
  | 'unspecified'
  | 'minutes'
  | 'pressRating'
  | 'audienceRating'
  | 'votes'
  | 'vote'
  | 'imdbRating'
  | 'ratingLabel'
  | 'openImdb'
  | 'openAllocine'
  | 'openRt'
  | 'certifiedFresh'
  | 'rottenTomatoes'
  | 'ratingAbsent'
  | 'ratingBlocked'
  | 'ratingPending'
  | 'retryFailed'
  | 'retryFailedTooltip'
  | 'retryInProgress'
  | 'retryDone'
  | 'searchPlaceholder'
  | 'today'
  | 'language'
  | 'french'
  | 'english'
  | 'noSessions'
  // ── Generic UI labels (shared across components) ───────────────────────
  | 'clear'
  | 'export'
  | 'autoScroll'
  | 'allComponents'
  | 'filterMessages'
  | 'noLogEntries'
  | 'logAll'
  | 'minHour'
  | 'maxHour'
  // ── Error boundary ───────────────────────────────────────────────────
  | 'errorBoundaryTitle'
  | 'errorBoundaryMessage'
  | 'reload'
  // ── Cinema status banner ──────────────────────────────────────────────
  | 'cinemaStatus_timeout'
  | 'cinemaStatus_http-error'
  | 'cinemaStatus_parse-error'
  | 'cinemaUnavailable'
  // ── Progress bar ──────────────────────────────────────────────────────
  | 'ratingsProgress'
  // ── Diagnostics panel ──────────────────────────────────────────────────
  | 'diagnostics'
  | 'diagnosticsTitle'
  | 'diagnosticsCinemas'
  | 'diagnosticsRatingSources'
  | 'diagnosticsBlockedFilms'
  | 'diagnosticsCopy'
  | 'diagnosticsCopied'
  | 'diagnosticsReportIssue'
  | 'diagnosticsNoBlocked'
  | 'diagnosticsNetworkActive'
  | 'diagnosticsNetworkIdle'
  | 'diagnosticsMoviesLoaded'
  | 'diagnosticsLastLogs'
  // ── About panel ────────────────────────────────────────────────────────
  | 'about'
  | 'aboutTitle'
  | 'close'
  | 'aboutLicense'
  | 'aboutLicenseIntro'
  | 'aboutDependencies'
  | 'aboutDependenciesIntro'
  | 'aboutAttributions'
  | 'aboutPersonalUse'
  | 'aboutPersonalUseDescription'
  | 'aboutImdbDescription'
  | 'aboutWikidataDescription';

type Translations = Record<TranslationKey, { fr: string; en: string }>;

export const TRANSLATIONS: Translations = {
  appTitle: { fr: 'ArveCinema', en: 'ArveCinema' },
  loading: { fr: 'Chargement des séances…', en: 'Loading showtimes…' },
  error: { fr: 'Erreur', en: 'Error' },
  noResults: { fr: 'Aucun film ne correspond à ces filtres.', en: 'No films match these filters.' },
  noShowtimes: { fr: 'Aucune séance dans cette plage.', en: 'No showtimes in this range.' },
  allCinemas: { fr: 'Tous', en: 'All' },
  cinema: { fr: 'Cinéma', en: 'Cinema' },
  allDays: { fr: 'Tous les jours', en: 'All days' },
  allVersions: { fr: 'Tous', en: 'All' },
  vf: { fr: 'VF', en: 'VF' },
  vo: { fr: 'VO', en: 'VO' },
  hourRange: { fr: 'Horaire', en: 'Time' },
  sortBy: { fr: 'Trier', en: 'Sort' },
  sort_nextScreening: { fr: 'Prochaine séance', en: 'Next screening' },
  sort_title: { fr: 'Titre', en: 'Title' },
  sort_cinema: { fr: 'Cinéma', en: 'Cinema' },
  dayView: { fr: 'Jour', en: 'Day' },
  weekView: { fr: 'Semaine', en: 'Week' },
  refresh: { fr: 'Actualiser', en: 'Refresh' },
  refreshTooltip: { fr: 'Actualiser les séances', en: 'Refresh showtimes' },
  themeToggle_dark: { fr: 'Passer en thème clair', en: 'Switch to light theme' },
  themeToggle_light: { fr: 'Passer en thème sombre', en: 'Switch to dark theme' },
  updated: { fr: 'Mis à jour à', en: 'Updated at' },
  films: { fr: 'films', en: 'films' },
  film: { fr: 'film', en: 'film' },
  cinemas: { fr: 'cinémas', en: 'cinemas' },
  cinema_singular: { fr: 'cinéma', en: 'cinema' },
  week: { fr: 'semaine', en: 'week' },
  realization: { fr: 'Réalisation', en: 'Director' },
  with_: { fr: 'Avec', en: 'Cast' },
  noPoster: { fr: "Pas d'affiche", en: 'No poster' },
  noRatingsFound: {
    fr: "Wikidata n'a pas trouvé ce film — pas de notes disponibles",
    en: 'Wikidata did not find this film — no ratings available',
  },
  screen: { fr: 'Salle', en: 'Screen' },
  version: { fr: 'Version', en: 'Version' },
  unspecified: { fr: 'Non spécifié', en: 'Not specified' },
  minutes: { fr: 'min', en: 'min' },
  pressRating: { fr: 'Presse', en: 'Press' },
  audienceRating: { fr: 'Spectateurs', en: 'Audience' },
  votes: { fr: 'votes', en: 'votes' },
  vote: { fr: 'vote', en: 'vote' },
  imdbRating: { fr: 'IMDB', en: 'IMDB' },
  ratingLabel: { fr: 'Note', en: 'Rating' },
  openImdb: { fr: 'Cliquez pour ouvrir la fiche IMDB', en: 'Click to open IMDB page' },
  openAllocine: { fr: 'Cliquez pour ouvrir la fiche AlloCiné', en: 'Click to open AlloCiné page' },
  openRt: { fr: 'Cliquez pour ouvrir la fiche RT', en: 'Click to open RT page' },
  certifiedFresh: { fr: '🍅 Certified Fresh', en: '🍅 Certified Fresh' },
  rottenTomatoes: { fr: 'Rotten Tomatoes', en: 'Rotten Tomatoes' },
  ratingAbsent: { fr: 'Pas de note sur cette source', en: 'No rating on this source' },
  ratingBlocked: { fr: 'Échec de récupération', en: 'Fetch failed' },
  ratingPending: { fr: 'Récupération en cours…', en: 'Fetching…' },
  retryFailed: { fr: 'Réessayer les notes', en: 'Retry ratings' },
  retryFailedTooltip: {
    fr: 'Re-tenter les notes échouées (Cloudflare, erreurs réseau)',
    en: 'Retry failed rating lookups (Cloudflare, network errors)',
  },
  retryInProgress: { fr: 'Nouvel essai en cours…', en: 'Retry in progress…' },
  retryDone: {
    fr: '{recovered} récupérée(s) sur {retried}',
    en: '{recovered} of {retried} recovered',
  },
  searchPlaceholder: {
    fr: 'Rechercher : titre, réalisateur, acteur…',
    en: 'Search: title, director, actor…',
  },
  today: { fr: "Aujourd'hui", en: 'Today' },
  language: { fr: 'Langue', en: 'Language' },
  french: { fr: 'Français', en: 'French' },
  english: { fr: 'Anglais', en: 'English' },
  noSessions: { fr: 'Aucune séance dans cette plage.', en: 'No showtimes in this range.' },

  // ── Generic UI labels (shared across components) ──────────────────────────
  clear: { fr: 'Effacer', en: 'Clear' },
  export: { fr: 'Exporter', en: 'Export' },
  autoScroll: { fr: 'Défilement auto', en: 'Auto-scroll' },
  allComponents: { fr: 'Tous les composants', en: 'All components' },
  filterMessages: { fr: 'Filtrer les messages…', en: 'Filter messages…' },
  noLogEntries: { fr: 'Aucune entrée de log', en: 'No log entries' },
  logAll: { fr: 'Tous', en: 'All' },
  minHour: { fr: 'Heure minimum', en: 'Minimum hour' },
  maxHour: { fr: 'Heure maximum', en: 'Maximum hour' },

  // ── Error boundary ──────────────────────────────────────────────────────────
  errorBoundaryTitle: { fr: 'Une erreur est survenue', en: 'An error occurred' },
  errorBoundaryMessage: {
    fr: "L'application a rencontré un problème inattendu. Essayez de la recharger.",
    en: 'The application encountered an unexpected problem. Try reloading it.',
  },
  reload: { fr: 'Recharger', en: 'Reload' },

  // ── Cinema status banner ───────────────────────────────────────────────────
  cinemaStatus_timeout: { fr: 'délai dépassé', en: 'timed out' },
  'cinemaStatus_http-error': { fr: 'erreur HTTP', en: 'HTTP error' },
  'cinemaStatus_parse-error': { fr: 'format du site modifié', en: 'site format changed' },
  cinemaUnavailable: {
    fr: 'programmation temporairement indisponible',
    en: 'schedule temporarily unavailable',
  },

  // ── Progress bar ───────────────────────────────────────────────────────────
  ratingsProgress: { fr: 'Notes : {resolved}/{total}', en: 'Ratings: {resolved}/{total}' },

  // ── Diagnostics panel ──────────────────────────────────────────────────────
  diagnostics: { fr: 'Diagnostics', en: 'Diagnostics' },
  diagnosticsTitle: { fr: 'Diagnostics', en: 'Diagnostics' },
  diagnosticsCinemas: { fr: 'Cinéma', en: 'Cinemas' },
  diagnosticsRatingSources: { fr: 'Sources de notes', en: 'Rating sources' },
  diagnosticsBlockedFilms: { fr: 'Films bloqués', en: 'Blocked films' },
  diagnosticsCopy: { fr: 'Copier les diagnostics', en: 'Copy diagnostics' },
  diagnosticsCopied: { fr: 'Copié !', en: 'Copied!' },
  diagnosticsReportIssue: { fr: 'Signaler un problème', en: 'Report issue' },
  diagnosticsNoBlocked: { fr: 'Aucun film bloqué', en: 'No blocked films' },
  diagnosticsNetworkActive: { fr: 'Réseau actif', en: 'Network active' },
  diagnosticsNetworkIdle: { fr: 'Réseau inactif', en: 'Network idle' },
  diagnosticsMoviesLoaded: { fr: '{count} films chargés', en: '{count} movies loaded' },
  diagnosticsLastLogs: { fr: 'Dernières entrées de log', en: 'Last log entries' },

  // ── About panel ────────────────────────────────────────────────────────────
  about: { fr: 'À propos', en: 'About' },
  aboutTitle: { fr: "À propos d'ArveCinema", en: 'About ArveCinema' },
  close: { fr: 'Fermer', en: 'Close' },
  aboutLicense: { fr: 'Licence', en: 'License' },
  aboutLicenseIntro: {
    fr: 'Ce logiciel est distribué sous la licence BSD 3-Clause. Voir le fichier',
    en: 'This software is distributed under the BSD 3-Clause license. See the',
  },
  aboutDependencies: { fr: 'Bibliothèques utilisées', en: 'Used software' },
  aboutDependenciesIntro: {
    fr: "ArveCinema s'appuie sur les logiciels open-source suivants :",
    en: 'ArveCinema relies on the following open-source software:',
  },
  aboutAttributions: { fr: 'Informations', en: 'Information' },
  aboutPersonalUse: { fr: 'Application de navigation personnelle', en: 'Personal navigation app' },
  aboutPersonalUseDescription: {
    fr: "ArveCinema est une application de navigation personnelle permettant de consulter les horaires de séances des cinémas de la vallée de l'Arve. Les horaires proviennent directement des sites web des cinémas. Les notes et métadonnées affichées sont obtenues à des fins d'information personnelle et non commerciale. Aucune donnée n'est rediffusée ni revendue.",
    en: 'ArveCinema is a personal navigation app for browsing cinema showtimes in the Arve Valley. Showtimes are fetched directly from cinema websites. Ratings and metadata displayed are retrieved for personal, non-commercial informational purposes only. No data is republished or sold.',
  },
  aboutImdbDescription: {
    fr: 'Notes IMDB issues du jeu de données public officiel (title.ratings.tsv.gz), téléchargé quotidiennement depuis datasets.imdbws.com.',
    en: 'IMDB ratings sourced from the official public dataset (title.ratings.tsv.gz), downloaded daily from datasets.imdbws.com.',
  },
  aboutWikidataDescription: {
    fr: 'Correspondances titre → ID IMDB résolues via les identifiants Wikidata (P345). Données sous licence CC0.',
    en: 'Title → IMDB ID resolution via Wikidata identifiers (P345). Data released under CC0.',
  },
};

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
