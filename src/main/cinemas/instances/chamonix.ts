// Cinema instance: Cinéma Vox (Chamonix)
// Site: https://www.cinemavox-chamonix.com
// Adapter: cinevox (cotecine CMS, ISO-8859-1, booking URL timestamp parsing)
import type { CinemaInstance } from '../adapters/plugin';

const cinema: CinemaInstance = {
  id: 'chamonix',
  name: 'Cinéma Vox',
  city: 'Chamonix',
  color: '#a855f7',
  adapter: {
    kind: 'cinevox',
    baseUrl: 'https://www.cinemavox-chamonix.com',
  },
};

export default cinema;
