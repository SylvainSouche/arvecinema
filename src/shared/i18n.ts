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
  | 'minutes'
  | 'pressRating'
  | 'audienceRating'
  | 'votes'
  | 'vote'
  | 'imdbRating'
  | 'openImdb'
  | 'openAllocine'
  | 'openRt'
  | 'certifiedFresh'
  | 'rottenTomatoes'
  | 'settings'
  | 'settingsTitle'
  | 'settingsDesc'
  | 'apiKey'
  | 'username'
  | 'subscriptionKey'
  | 'save'
  | 'cancel'
  | 'testing'
  | 'saveAndTest'
  | 'valid'
  | 'invalid'
  | 'noCredentials'
  | 'close'
  | 'searchPlaceholder'
  | 'today'
  | 'language'
  | 'french'
  | 'english'
  | 'noSessions';

type Translations = Record<TranslationKey, { fr: string; en: string }>;

export const TRANSLATIONS: Translations = {
  appTitle:           { fr: 'ArveCinema', en: 'ArveCinema' },
  loading:            { fr: 'Chargement des séances…', en: 'Loading showtimes…' },
  error:              { fr: 'Erreur', en: 'Error' },
  noResults:          { fr: 'Aucun film ne correspond à ces filtres.', en: 'No films match these filters.' },
  noShowtimes:        { fr: 'Aucune séance dans cette plage.', en: 'No showtimes in this range.' },
  allCinemas:         { fr: 'Tous', en: 'All' },
  cinema:             { fr: 'Cinéma', en: 'Cinema' },
  allDays:            { fr: 'Tous les jours', en: 'All days' },
  allVersions:        { fr: 'Tous', en: 'All' },
  vf:                 { fr: 'VF', en: 'VF' },
  vo:                 { fr: 'VO', en: 'VO' },
  hourRange:          { fr: 'Horaire', en: 'Time' },
  sortBy:             { fr: 'Trier', en: 'Sort' },
  sort_nextScreening: { fr: 'Prochaine séance', en: 'Next screening' },
  sort_title:         { fr: 'Titre', en: 'Title' },
  sort_cinema:        { fr: 'Cinéma', en: 'Cinema' },
  dayView:            { fr: 'Jour', en: 'Day' },
  weekView:           { fr: 'Semaine', en: 'Week' },
  refresh:            { fr: 'Actualiser', en: 'Refresh' },
  refreshTooltip:     { fr: 'Actualiser les séances', en: 'Refresh showtimes' },
  themeToggle_dark:   { fr: 'Passer en thème clair', en: 'Switch to light theme' },
  themeToggle_light:  { fr: 'Passer en thème sombre', en: 'Switch to dark theme' },
  updated:            { fr: 'Mis à jour à', en: 'Updated at' },
  films:              { fr: 'films', en: 'films' },
  film:               { fr: 'film', en: 'film' },
  cinemas:            { fr: 'cinémas', en: 'cinemas' },
  cinema_singular:    { fr: 'cinéma', en: 'cinema' },
  week:               { fr: 'semaine', en: 'week' },
  realization:        { fr: 'Réalisation', en: 'Director' },
  with_:              { fr: 'Avec', en: 'Cast' },
  noPoster:           { fr: "Pas d'affiche", en: 'No poster' },
  minutes:            { fr: 'min', en: 'min' },
  pressRating:       { fr: 'Presse', en: 'Press' },
  audienceRating:    { fr: 'Spectateurs', en: 'Audience' },
  votes:              { fr: 'votes', en: 'votes' },
  vote:               { fr: 'vote', en: 'vote' },
  imdbRating:       { fr: 'IMDB', en: 'IMDB' },
  openImdb:          { fr: 'Cliquez pour ouvrir la fiche IMDB', en: 'Click to open IMDB page' },
  openAllocine:     { fr: 'Cliquez pour ouvrir la fiche AlloCiné', en: 'Click to open AlloCiné page' },
  openRt:           { fr: 'Cliquez pour ouvrir la fiche RT', en: 'Click to open RT page' },
  certifiedFresh:   { fr: '🍅 Certified Fresh', en: '🍅 Certified Fresh' },
  rottenTomatoes:   { fr: 'Rotten Tomatoes', en: 'Rotten Tomatoes' },
  settings:          { fr: 'Réglages', en: 'Settings' },
  settingsTitle:     { fr: 'Réglages', en: 'Settings' },
  settingsDesc:      { fr: 'Pour afficher les notes des films, configurez vos identifiants', en: 'To display film ratings, configure your credentials' },
  apiKey:            { fr: 'Clé API', en: 'API Key' },
  username:          { fr: "Nom d'utilisateur", en: 'Username' },
  subscriptionKey:   { fr: "Clé d'abonnement", en: 'Subscription key' },
  save:              { fr: 'Enregistrer', en: 'Save' },
  cancel:            { fr: 'Annuler', en: 'Cancel' },
  testing:           { fr: 'Test…', en: 'Testing…' },
  saveAndTest:       { fr: 'Enregistrer et tester', en: 'Save and test' },
  valid:             { fr: 'Credentials valides', en: 'Valid credentials' },
  invalid:           { fr: 'Échec de la requête (vérifiez vos credentials)', en: 'Request failed (check your credentials)' },
  noCredentials:     { fr: 'Aucun credential configuré', en: 'No credentials configured' },
  close:             { fr: 'Fermer', en: 'Close' },
  searchPlaceholder: { fr: 'Rechercher : titre, réalisateur, acteur…', en: 'Search: title, director, actor…' },
  today:             { fr: "Aujourd'hui", en: 'Today' },
  language:          { fr: 'Langue', en: 'Language' },
  french:            { fr: 'Français', en: 'French' },
  english:           { fr: 'Anglais', en: 'English' },
  noSessions:        { fr: 'Aucune séance dans cette plage.', en: 'No showtimes in this range.' },
};

// ── Locale storage ─────────────────────────────────────────────────────────

let currentLocale: Locale = (() => {
  try { return (localStorage.getItem(STORAGE_KEY) as Locale) ?? DEFAULT_LOCALE; }
  catch { return DEFAULT_LOCALE; }
})();

const listeners = new Set<() => void>();

export function getLocale(): Locale { return currentLocale; }

export function setLocale(locale: Locale): void {
  currentLocale = locale;
  try { localStorage.setItem(STORAGE_KEY, locale); } catch { /* ignore */ }
  listeners.forEach(fn => fn());
}

/** Translate a key using the current locale. */
export function t(key: TranslationKey): string {
  const entry = TRANSLATIONS[key];
  if (!entry) return key;
  return entry[currentLocale] ?? entry.fr;
}

/** Translate a key with a specific locale (bypasses the global state). */
export function tIn(key: TranslationKey, locale: Locale): string {
  const entry = TRANSLATIONS[key];
  if (!entry) return key;
  return entry[locale] ?? entry.fr;
}

// ── React hook ──────────────────────────────────────────────────────────────

/** React hook that subscribes to locale changes and triggers re-renders. */
export function useLocale(): { locale: Locale; setLocale: (l: Locale) => void; t: (k: TranslationKey) => string } {
  const [, setTick] = useState(0);

  useEffect(() => {
    const fn = () => setTick(n => n + 1);
    listeners.add(fn);
    return () => { listeners.delete(fn); };
  }, []);

  const changeLocale = useCallback((l: Locale) => setLocale(l), []);

  return { locale: currentLocale, setLocale: changeLocale, t };
}
