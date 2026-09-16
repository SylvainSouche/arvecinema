import type { Cinema } from './types';
import type { CinemaInfo } from '../../shared/types';
import { createBoxOfficeApiAdapter } from './boxOfficeApiAdapter';
import { createCineChateauAdapter } from './cineChateauAdapter';
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
// Two adapter factories are provided out of the box:
//   - createBoxOfficeApiAdapter  — for any gatsby-source-boxofficeapi site
//                                  (Mont-Blanc, Cluses, …). Only requires
//                                  baseUrl + theaterId.
//   - createCineChateauAdapter   — for cinechateau.fr (Bonneville). HTML
//                                  scraping. Only requires baseUrl.
//   - createCineVoxAdapter       — for cinemavox-chamonix.com (Chamonix).
//                                  Same HTML structure as cinechateau but
//                                  ISO-8859-1 encoded; uses the booking
//                                  URL's embedded Unix timestamp for exact
//                                  dates (no day-tab inference needed).
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
    adapter: createCineChateauAdapter('bonneville', {
      baseUrl: 'https://www.cinechateau.fr',
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
