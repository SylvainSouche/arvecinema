// Cinema instance: Ciné Mont-Blanc (Sallanches)
// Site: https://www.cinemontblanc.fr
// Adapter: boxofficeapi (Gatsby + gatsby-source-boxofficeapi stack)
import type { CinemaInstance } from '../adapters/plugin';

const cinema: CinemaInstance = {
  id: 'mont-blanc',
  name: 'Ciné Mont-Blanc',
  city: 'Sallanches',
  color: '#e50914',
  adapter: {
    kind: 'boxofficeapi',
    baseUrl: 'https://www.cinemontblanc.fr',
    theaterId: 'P1798',
  },
};

export default cinema;
