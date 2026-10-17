import type { Movie } from '../cinemas/types';

// ──────────────────────────────────────────────────────────────────────────
// ratingUpdates — single source of truth for the `rating:updated` event
// shape (review MAINT-01 territory, extracted as part of ARCH-01: three
// call sites previously duplicated this mapping by hand and could drift).
//
// Pure/electron-free: the IPC layer (ipcRegistrar) takes care of the
// broadcast to the windows; here, a Movie becomes the message.
// ──────────────────────────────────────────────────────────────────────────

/** Shape sent over the `rating:updated` channel; the renderer merges
 *  `ratings` into any Movie whose (cinemaId, id) matches. */
export interface RatingUpdateMessage {
  cinemaId: string;
  movieId: string;
  ratings: {
    imdbId?: string;
    imdbRating?: number;
    imdbVotes?: number;
    imdbUrl?: string;
    imdbStatus?: Movie['imdbStatus'];
    imdbStatusMessage?: string;
    allocinePress?: number | null;
    allocineAudience?: number | null;
    allocineVotes?: number;
    allocineUrl?: string;
    allocineStatus?: Movie['allocineStatus'];
    allocineStatusMessage?: string;
    rtTomatometer?: number | null;
    rtCertifiedFresh?: boolean;
    rtUrl?: string;
    rtStatus?: Movie['rtStatus'];
    rtStatusMessage?: string;
    wikidataUrl?: string;
  };
}

/** Map a (mutated, enriched) Movie to the per-movie ratings broadcast. */
export function movieToRatingUpdate(movie: Movie): RatingUpdateMessage {
  return {
    cinemaId: movie.cinemaId,
    movieId: movie.id,
    ratings: {
      imdbId: movie.imdbId,
      imdbRating: movie.imdbRating,
      imdbVotes: movie.imdbVotes,
      imdbUrl: movie.imdbUrl,
      imdbStatus: movie.imdbStatus,
      imdbStatusMessage: movie.imdbStatusMessage,
      allocinePress: movie.allocinePress,
      allocineAudience: movie.allocineAudience,
      allocineVotes: movie.allocineVotes,
      allocineUrl: movie.allocineUrl,
      allocineStatus: movie.allocineStatus,
      allocineStatusMessage: movie.allocineStatusMessage,
      rtTomatometer: movie.rtTomatometer,
      rtCertifiedFresh: movie.rtCertifiedFresh,
      rtUrl: movie.rtUrl,
      rtStatus: movie.rtStatus,
      rtStatusMessage: movie.rtStatusMessage,
      wikidataUrl: movie.wikidataUrl,
    },
  };
}
