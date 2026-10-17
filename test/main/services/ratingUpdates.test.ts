// ──────────────────────────────────────────────────────────────────────────
// ratingUpdates tests — the `rating:updated` payload mapper. Three call
// sites used to duplicate this by hand; this suite pins the exact shape the
// renderer merges into movie state.
// ──────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from 'vitest';
import { movieToRatingUpdate } from '../../../src/main/services/ratingUpdates';
import type { Movie } from '../../../src/main/cinemas/types';

const fixture: Movie = {
  id: 'm-1',
  cinemaId: 'cluses',
  title: 'Portrait',
  hasVF: true,
  hasVO: false,
  showtimes: [],
  imdbRating: 7.4,
  imdbVotes: 1520,
  imdbUrl: 'https://www.imdb.com/title/tt9',
  imdbStatus: 'ok',
  imdbStatusMessage: undefined,
  allocinePress: 3.8,
  allocineAudience: 3.1,
  allocineVotes: 240,
  allocineUrl: 'https://www.allocine.fr/film/x',
  allocineStatus: 'ok',
  rtTomatometer: 91,
  rtCertifiedFresh: true,
  rtUrl: 'https://www.rottentomatoes.com/m/x',
  rtStatus: 'ok',
  wikidataUrl: 'https://www.wikidata.org/entity/Q1',
} as unknown as Movie;

describe('movieToRatingUpdate', () => {
  it('maps the full rating payload (renderer merge relies on every key)', () => {
    const msg = movieToRatingUpdate(fixture);
    expect(msg.cinemaId).toBe('cluses');
    expect(msg.movieId).toBe('m-1');
    expect(msg.ratings).toMatchObject({
      imdbRating: 7.4,
      imdbVotes: 1520,
      imdbUrl: 'https://www.imdb.com/title/tt9',
      imdbStatus: 'ok',
      allocinePress: 3.8,
      allocineAudience: 3.1,
      allocineVotes: 240,
      allocineUrl: 'https://www.allocine.fr/film/x',
      rtTomatometer: 91,
      rtCertifiedFresh: true,
      rtUrl: 'https://www.rottentomatoes.com/m/x',
      rtStatus: 'ok',
      wikidataUrl: 'https://www.wikidata.org/entity/Q1',
    });
  });

  it('does not carry showtimes or unrelated fields (payload stays small)', () => {
    const msg = movieToRatingUpdate(fixture) as unknown as Record<string, unknown>;
    expect(Object.keys(msg).sort()).toEqual(['cinemaId', 'movieId', 'ratings']);
    expect(msg.ratings).not.toHaveProperty('showtimes');
    expect(msg.ratings).not.toHaveProperty('title');
  });

  it('all undefined ratings pass through as undefined (renderer skips them)', () => {
    const bare = {
      id: 'm-2',
      cinemaId: 'c',
      title: 'x',
      hasVF: false,
      hasVO: false,
      showtimes: [],
    } as unknown as Movie;
    const msg = movieToRatingUpdate(bare);
    expect(msg.ratings.imdbRating).toBeUndefined();
    expect(msg.ratings.imdbStatus).toBeUndefined();
  });
});
