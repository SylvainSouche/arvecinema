// Cinema instance: Ciné Château (Bonneville)
// Site: https://www.cinechateau.fr
// Adapter: boxofficeapi (the site was redesigned from cotecine.fr to
// Gatsby 5.14.6 + boxofficeapi in v0.7.5; theaterId W7412)
import type { CinemaInstance } from '../adapters/plugin';

const cinema: CinemaInstance = {
  id: 'bonneville',
  name: 'Ciné Château',
  city: 'Bonneville',
  color: '#10b981',
  adapter: {
    kind: 'boxofficeapi',
    baseUrl: 'https://www.cinechateau.fr',
    theaterId: 'W7412',
  },
};

export default cinema;
