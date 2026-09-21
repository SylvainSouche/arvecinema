// Cinema instance: Ciné de Cluses (Cluses)
// Site: https://www.cine-cluses.fr
// Adapter: boxofficeapi (Gatsby + gatsby-source-boxofficeapi stack)
import type { CinemaInstance } from '../adapters/plugin';

const cinema: CinemaInstance = {
  id: 'cluses',
  name: 'Ciné de Cluses',
  city: 'Cluses',
  color: '#3b82f6',
  adapter: {
    kind: 'boxofficeapi',
    baseUrl: 'https://www.cine-cluses.fr',
    theaterId: 'P6733',
  },
};

export default cinema;
