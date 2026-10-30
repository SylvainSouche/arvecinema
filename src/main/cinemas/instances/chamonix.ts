// Cinema instance: Cinéma Vox (Chamonix)
// Site: https://www.cinemavox-chamonix.com
// Adapter: boxofficeapi — 2026-10-30: the site was migrated from the old
// cotecine HTML pages (cheerio `cinevox` adapter) to the same Gatsby /
// gatsby-source-boxofficeapi stack as the mont-blanc / cine-cluses /
// cinechateau sites (theater id from <meta name="bocms:theater:id">).
// The old adapter remains available for other (or custom) cotecine sites.
import type { CinemaInstance } from '../adapters/plugin';

const cinema: CinemaInstance = {
  id: 'chamonix',
  name: 'Cinéma Vox',
  city: 'Chamonix',
  color: '#a855f7',
  adapter: {
    kind: 'boxofficeapi',
    baseUrl: 'https://www.cinemavox-chamonix.com',
    theaterId: 'P1406',
  },
};

export default cinema;
