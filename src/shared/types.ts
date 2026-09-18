// ──────────────────────────────────────────────────────────────────────────
// Shared domain types — single source of truth for both the main process
// (cinema adapters, IPC handlers) and the renderer (React components).
//
// WHY: previously the same interfaces were declared in two places
// (src/main/cinemas/types.ts and src/renderer/types/index.ts) and had drifted.
// Now both sides import from here.
// ──────────────────────────────────────────────────────────────────────────

/** A single screening of a movie at a specific cinema. */
export interface Showtime {
  /** ISO 8601 local time, e.g. "2026-09-09T19:45:00". No tz designator —
   *  always interpreted in Europe/Paris (the main process sets `process.env.TZ`). */
  time: string;
  /** Paris-local hour as a float. 19.75 means 19h45. Used by the hour filter. */
  hour: number;
  /** YYYY-MM-DD in Europe/Paris. Used by the day filter + WeekGrid rows. */
  day: string;
  /** Box-Office-API tag strings, e.g. "Localization.Version.Original". */
  tags: string[];
  /** Screen name if known, e.g. "Salle 5". */
  screen?: string;
  /** Ticketing URL if online booking is available. */
  ticketingUrl?: string;
  /** Which cinema this showtime belongs to. */
  cinemaId: string;
}

/** A movie and all its showtimes at one specific cinema. */
export interface Movie {
  /** ID unique within the cinema's source. We key React lists by `${cinemaId}-${id}`. */
  id: string;
  cinemaId: string;
  title: string;
  poster?: string;
  /** Comma-joined director names, or "Non spécifié" if unknown. */
  direction: string;
  /** Comma-joined actor names, or "Non spécifié" if unknown. */
  casting: string;
  synopsis?: string;
  /** Comma-joined genre labels. */
  genres?: string;
  /** ISO 8601 release date, e.g. "2026-07-29T00:00:00.000Z". */
  release?: string;
  /** Runtime in MINUTES (normalized across all adapters). */
  runtime?: number;
  hasVF: boolean;
  hasVO: boolean;
  showtimes: Showtime[];

  // ── Ratings (optional, populated by the ratings enricher) ────────────────
  /** IMDB ID (e.g. "tt22084616") from Wikidata P345. */
  imdbId?: string;
  /** IMDB rating on 10 (e.g. 7.8). */
  imdbRating?: number;
  /** Number of IMDB votes. */
  imdbVotes?: number;
  /** Full URL to the IMDB title page. */
  imdbUrl?: string;
  /** AlloCiné press rating (0-5, e.g. 2.6). */
  allocinePress?: number;
  /** AlloCiné audience rating (0-5, e.g. 3.3). */
  allocineAudience?: number;
  /** Number of AlloCiné audience votes. */
  allocineVotes?: number;
  /** Full URL to the AlloCiné film page. */
  allocineUrl?: string;
  /** Rotten Tomatoes Tomatometer (press) — 0-100 percentage. */
  rtTomatometer?: number;
  /** True if the film is RT "Certified Fresh". */
  rtCertifiedFresh?: boolean;
  /** Full URL to the Rotten Tomatoes movie page. */
  rtUrl?: string;

  // ── Rating source statuses (for the green/red indicator) ─────────────────
  /** Status of the AlloCiné fetch: 'ok' | 'absent' | 'blocked'. */
  allocineStatus?: 'ok' | 'absent' | 'blocked';
  allocineStatusMessage?: string;
  /** Status of the IMDB fetch. */
  imdbStatus?: 'ok' | 'absent' | 'blocked';
  imdbStatusMessage?: string;
  /** Status of the RT fetch. */
  rtStatus?: 'ok' | 'absent' | 'blocked';
  rtStatusMessage?: string;

  /** Full URL to the Wikidata entity (for the info badge). */
  wikidataUrl?: string;

  // ── Adapter-private fields (not part of the public contract) ────────────
  /** External IDs from boxofficeapi — used by the ratings enricher to look
   *  up AlloCiné IDs. Present only on movies from the boxOfficeApiAdapter. */
  altId?: string[];
}

/** Public cinema metadata exposed to the renderer (no `adapter` function). */
export interface CinemaInfo {
  /** Stable slug, e.g. "mont-blanc". Used in IPC payloads + filter state. */
  id: string;
  /** Display name, e.g. "Ciné Mont-Blanc". */
  name: string;
  /** City, e.g. "Sallanches". */
  city: string;
  /** Hex color used for the cinema badge on each showtime chip. */
  color: string;
}

/** Response payload of the `schedule:fetch` IPC handler. */
export interface ScheduleResponse {
  /** YYYY-MM-DD ascending, union across all enabled cinemas. */
  availableDays: string[];
  movies: Movie[];
  /**
   * CMB-005: per-cinema status, so the renderer can distinguish "no
   * screenings" from "server unreachable". One entry per enabled cinema,
   * regardless of success/failure.
   */
  cinemaStatuses: CinemaStatus[];
}

/**
 * Per-cinema fetch outcome.
 *
 *   - 'ok'          — adapter returned a schedule (possibly empty).
 *   - 'timeout'     — request exceeded the timeout (see REQUEST_TIMEOUT_MS).
 *   - 'http-error'  — non-2xx HTTP status from the cinema server.
 *   - 'parse-error' — adapter couldn't parse the response (scraper schema
 *                     change, JSON shape changed, etc.).
 */
export interface CinemaStatus {
  cinemaId: string;
  status: 'ok' | 'timeout' | 'http-error' | 'parse-error';
  error?: string;   // human-readable message for the UI
  fetchedAt?: string;   // ISO timestamp of the fetch attempt
}

export type AudioFilter = 'ALL' | 'VF' | 'VO';

// ──────────────────────────────────────────────────────────────────────────
// VF / VO detection — single source of truth.
// Both the main process (when computing hasVF / hasVO per movie) and the
// renderer (when filtering showtimes by audio version) use these helpers.
// ──────────────────────────────────────────────────────────────────────────

const VF_TAGS = new Set([
  'Localization.Language.French',
  'Showtime.Accessibility.Dubbed',
]);
const VO_TAGS = new Set(['Localization.Version.Original']);

export const isVFShowtime = (tags: string[]): boolean =>
  tags.some(t => VF_TAGS.has(t));

export const isVOShowtime = (tags: string[]): boolean =>
  tags.some(t => VO_TAGS.has(t));

/** Returns "VO" if the showtime is original version, "VF" if French, "" otherwise. */
export const showtimeVersion = (tags: string[]): 'VF' | 'VO' | '' =>
  isVOShowtime(tags) ? 'VO' : isVFShowtime(tags) ? 'VF' : '';

// ──────────────────────────────────────────────────────────────────────────
// Constants
// ──────────────────────────────────────────────────────────────────────────

/** When a movie's runtime is unknown, assume 2h so the WeekGrid chip has a
 *  sensible width. Centralized here so any future user of the value gets
 *  the same default. */
export const DEFAULT_RUNTIME_HOURS = 2;

/** The cinema timezone. All Date math in the app runs in Europe/Paris because
 *  the main process sets `process.env.TZ = 'Europe/Paris'` at startup. */
export const TIMEZONE = 'Europe/Paris';

// ──────────────────────────────────────────────────────────────────────────
// Global Window augmentation — teaches TS that `window.electronAPI` exists.
// ──────────────────────────────────────────────────────────────────────────

declare global {
  interface Window {
    electronAPI: {
      fetchCinemas: () => Promise<CinemaInfo[]>;
      fetchSchedule: (cinemaIds?: string[]) => Promise<ScheduleResponse>;
      /** Open a ticketing URL via the main process's validated handler. */
      openTicket: (url: string) => Promise<boolean>;
      /** Progressive ratings: listen for per-movie rating updates.
       *  Returns an unsubscribe function. */
      onRatingUpdated: (callback: (data: {
        cinemaId: string;
        movieId: string;
        ratings: Record<string, unknown>;
      }) => void) => () => void;
      /** Enrichment progress: fires whenever a film finishes processing
       *  (either scraped or cache-hit). When `resolved === total`, the
       *  enrichment is complete. Returns an unsubscribe function. */
      onRatingsProgress: (callback: (data: {
        resolved: number;
        total: number;
        pct: number;
      }) => void) => () => void;
      /** Network activity state: fires `true` when any network operation
       *  starts (browserFetch, pooledFetch, dataset download) and `false`
       *  when all in-flight operations complete. Used to animate the
       *  refresh icon as a spinner. Returns an unsubscribe function. */
      onNetworkActivity: (callback: (active: boolean) => void) => () => void;
      /** DEV-ONLY: probe the IMDB Top 250 GraphQL endpoint. */
      probeTop250?: () => Promise<string>;
      /** DEV-ONLY: fetch ALL movies from ALL cinemas for export. */
      exportAll?: () => Promise<{ movies: Movie[]; cinemaStatuses: CinemaStatus[] }>;
    };
  }
}
