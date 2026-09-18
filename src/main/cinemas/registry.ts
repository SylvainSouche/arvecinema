import type { Cinema } from './types';
import type { CinemaInfo } from '../../shared/types';
import { createBoxOfficeApiAdapter } from './boxOfficeApiAdapter';
// cineChateauAdapter is no longer imported — Bonneville now uses boxOfficeApi.
// See cineChateauAdapter.ts for the sleeping backup.
import { createCineVoxAdapter } from './cineVoxAdapter';

// ──────────────────────────────────────────────────────────────────────────
// CINEMA REGISTRY — drop-in module
// ──────────────────────────────────────────────────────────────────────────
// To add a new cinema: append a Cinema object below. To remove one: delete its
// entry. No other file in the app needs to change.
//
// Each entry needs:
//   - id        : stable slug used in filters / IPC payloads
//   - name      : display name shown in the UI
//   - city      : town, shown as subtitle
//   - color     : hex color used for the cinema badge on each showtime chip
//   - adapter   : an object implementing CinemaAdapter (see types.ts)
//
// Adapter factories:
//   - createBoxOfficeApiAdapter  — for any gatsby-source-boxofficeapi site
//                                  (Mont-Blanc, Cluses, Bonneville). Only
//                                  requires baseUrl + theaterId.
//   - createCineChateauAdapter   — ⚠️ Sleeping backup. cinechateau.fr has
//                                  been redesigned to a Gatsby/boxOfficeApi
//                                  site. The old HTML scraper no longer works.
//   - createCineVoxAdapter       — for cinemavox-chamonix.com (Chamonix).
//                                  HTML scraping with ISO-8859-1 + booking
//                                  URL timestamp-based date resolution.
// ──────────────────────────────────────────────────────────────────────────

export const CINEMAS: Cinema[] = [
  {
    id: 'mont-blanc',
    name: 'Ciné Mont-Blanc',
    city: 'Sallanches',
    color: '#e50914',
    adapter: createBoxOfficeApiAdapter('mont-blanc', {
      baseUrl: 'https://www.cinemontblanc.fr',
      theaterId: 'P1798',
    }),
  },
  {
    id: 'cluses',
    name: 'Ciné de Cluses',
    city: 'Cluses',
    color: '#3b82f6',
    adapter: createBoxOfficeApiAdapter('cluses', {
      baseUrl: 'https://www.cine-cluses.fr',
      theaterId: 'P6733',
    }),
  },
  {
    id: 'bonneville',
    name: 'Ciné Château',
    city: 'Bonneville',
    color: '#10b981',
    // cinechateau.fr has been redesigned to a Gatsby 5.14.6 site using
    // the same boxOfficeApi as Mont-Blanc and Cluses. Theater ID: W7412.
    // The old cotecine.fr HTML scraper (cineChateauAdapter) is obsolete.
    adapter: createBoxOfficeApiAdapter('bonneville', {
      baseUrl: 'https://www.cinechateau.fr',
      theaterId: 'W7412',
    }),
  },
  {
    id: 'chamonix',
    name: 'Cinéma Vox',
    city: 'Chamonix',
    color: '#a855f7',
    adapter: createCineVoxAdapter('chamonix', {
      baseUrl: 'https://www.cinemavox-chamonix.com',
    }),
  },
];

/** Public metadata exposed to the renderer (without the adapter function). */
export const CINEMA_INFOS: CinemaInfo[] = CINEMAS.map(({ id, name, city, color }) => ({
  id, name, city, color,
}));
