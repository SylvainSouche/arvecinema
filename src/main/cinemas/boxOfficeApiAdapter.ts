import type { CinemaAdapter, Movie, Showtime } from './types';
import { APP_USER_AGENT } from '../../shared/userAgent';
import { isVFTags, isVOTags, TIMEZONE } from './types';
import { toIsoDay, parseShowtimeDate } from '../../shared/cinema';
import { fetchWithTimeout, REQUEST_TIMEOUT_MS } from '../../shared/fetchWithTimeout';

// ──────────────────────────────────────────────────────────────────────────
// boxofficeapi adapter
// ──────────────────────────────────────────────────────────────────────────
// Shared by every cinema whose website is built on the same Gatsby +
// gatsby-source-boxofficeapi stack (Mont-Blanc, Cluses, …). All that differs
// between them is the base URL + theater ID — those are passed in via the
// config object so a new cinema is a one-liner in registry.ts.
//
// Endpoints (verified against www.cinemontblanc.fr and www.cine-cluses.fr):
//   GET {baseUrl}/api/gatsby-source-boxofficeapi/schedule?from=&to=&theaters=
//     → { [theaterId]: { schedule, showtimesDates, moviesTags } }
//   GET {baseUrl}/api/gatsby-source-boxofficeapi/movies?ids=A&ids=B&ids=C
//     → [{ id, title, poster, casting[], direction[], synopsis, genres, release, runtime }]
//
// Runtime note: the API returns runtime in SECONDS. We normalize to MINUTES
// here so all adapters expose a consistent unit.
// ──────────────────────────────────────────────────────────────────────────

export interface BoxOfficeApiConfig {
  baseUrl: string;     // e.g. "https://www.cinemontblanc.fr"
  theaterId: string;   // e.g. "P1798"
  timeZone?: string;   // defaults to Europe/Paris
}

const HEADERS: Record<string, string> = {
  Accept: 'application/json',
  // NET-01: identify the app honestly rather than impersonating Safari.
  // A cinema site operator seeing unusual traffic can find us instead of
  // blocking the UA outright.
  'User-Agent': APP_USER_AGENT,
};

/** Build per-cinema headers: the Referer must point at THIS cinema's origin,
 *  not always Mont-Blanc. Sending cinemontblanc.fr as the Referer to
 *  cine-cluses.fr is at best a log-entry curiosity, at worst a future
 *  rejection if either site starts validating the header. */
const buildHeaders = (baseUrl: string): Record<string, string> => ({
  ...HEADERS,
  Referer: baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`,
});

/** Placeholder used when the API doesn't return a value. */
const UNKNOWN = 'Non spécifié';

/**
 * Build a BoxOfficeApi adapter for one cinema.
 *
 * @param cinemaId  the slug used in `cinemaId` fields of resulting Showtime/Movie objects
 * @param cfg       endpoint configuration for this cinema
 */
export function createBoxOfficeApiAdapter(
  cinemaId: string,
  cfg: BoxOfficeApiConfig,
): CinemaAdapter {
  const timeZone = cfg.timeZone ?? TIMEZONE;
  const headers = buildHeaders(cfg.baseUrl);

  return {
    async fetchSchedule(windowDays: number) {
      // Schedule window: today 03:00 Europe/Paris → today+windowDays 03:00.
      // process.env.TZ = 'Europe/Paris' (set by the main process at startup)
      // so setHours / setDate operate in Paris time.
      const today = new Date();
      const from = new Date(today);
      from.setHours(3, 0, 0, 0);
      const to = new Date(today);
      to.setDate(to.getDate() + windowDays);
      to.setHours(3, 0, 0, 0);

      const params = new URLSearchParams({
        from: from.toISOString(),
        to: to.toISOString(),
        theaters: JSON.stringify({ id: cfg.theaterId, timeZone }),
      });

      const schedRes = await fetchWithTimeout(
        `${cfg.baseUrl}/api/gatsby-source-boxofficeapi/schedule?${params}`,
        { headers },
        REQUEST_TIMEOUT_MS,
      );
      if (!schedRes.ok) {
        throw new Error(`${cinemaId}: schedule HTTP ${schedRes.status}`);
      }

      const raw: unknown = await schedRes.json();
      const theaterData = (raw as Record<string, any>)[cfg.theaterId];
      if (!theaterData?.schedule) {
        return { availableDays: [], movies: [] };
      }

      const schedule = theaterData.schedule as Record<string, Record<string, any[]>>;
      const availableDays: string[] = Array.isArray(theaterData.showtimesDates)
        ? [...theaterData.showtimesDates as string[]].sort()
        : [];

      // Phase 1 — collect showtimes per movie, with placeholder metadata.
      //
      // BUG-01 fix: each showtime is validated individually. A malformed
      // `startsAt` field (null, undefined, unparseable string) skips that
      // row rather than throwing and dropping the whole cinema. Previously,
      // `toIsoDay(new Date(undefined))` would throw a RangeError that escaped
      // `fetchSchedule` and was misclassified as 'http-error'.
      const moviesById = new Map<string, Movie>();
      let skippedShowtimes = 0;

      for (const [movieId, dates] of Object.entries(schedule)) {
        const showtimes: Showtime[] = [];
        let hasVF = false;
        let hasVO = false;

        for (const dayShowtimes of Object.values(dates)) {
          for (const st of dayShowtimes) {
            // Validate the raw showtime object before consuming any field.
            if (!st || typeof st !== 'object') { skippedShowtimes++; continue; }
            const d = parseShowtimeDate(st.startsAt);
            if (!d) { skippedShowtimes++; continue; }
            // Tags: defensively coerce to string[].
            const tags: string[] = Array.isArray(st.tags)
              ? st.tags.filter((t: unknown): t is string => typeof t === 'string')
              : [];
            const hour = d.getHours() + d.getMinutes() / 60;
            const day = toIsoDay(d);

            if (isVFTags(tags)) hasVF = true;
            if (isVOTags(tags)) hasVO = true;

            showtimes.push({
              time: st.startsAt as string,
              hour, day, tags,
              screen: typeof st.screen?.name === 'string' ? st.screen.name : undefined,
              ticketingUrl:
                typeof st.data?.ticketing?.[0]?.urls?.[0] === 'string'
                  ? st.data.ticketing[0].urls[0]
                  : undefined,
              cinemaId,
            });
          }
        }

        if (showtimes.length === 0) continue;
        showtimes.sort((a, b) => a.time.localeCompare(b.time));

        moviesById.set(movieId, {
          id: movieId,
          cinemaId,
          title: `Film ${movieId}`,
          poster: '',
          direction: UNKNOWN,
          casting: UNKNOWN,
          synopsis: '',
          hasVF, hasVO, showtimes,
        });
      }

      if (skippedShowtimes > 0) {
        console.warn(`[cinemas] ${cinemaId}: skipped ${skippedShowtimes} malformed showtime(s)`);
      }

      // Phase 2 — batched movie metadata fetch via the plural `movies` endpoint.
      // The singular `?id=` variant returns HTML, not JSON — that's the bug
      // that previously caused "Film 276608" placeholders to leak through.
      //
      // CMB-015: batch metadata requests in chunks of 80 IDs to avoid URL
      // length limits. Realistic cinemas have 10–30 movies, but the limit
      // matters for very large programmes.
      if (moviesById.size > 0) {
        const allIds = [...moviesById.keys()];
        const BATCH_SIZE = 80;
        for (let i = 0; i < allIds.length; i += BATCH_SIZE) {
          const batch = allIds.slice(i, i + BATCH_SIZE);
          const metaParams = new URLSearchParams();
          for (const id of batch) metaParams.append('ids', id);

          try {
            const metaRes = await fetchWithTimeout(
              `${cfg.baseUrl}/api/gatsby-source-boxofficeapi/movies?${metaParams}`,
              { headers },
              REQUEST_TIMEOUT_MS,
            );
            if (metaRes.ok) {
              const metaList: unknown = await metaRes.json();
              if (Array.isArray(metaList)) {
                for (const m of metaList as any[]) {
                  const local = moviesById.get(String(m.id));
                  if (!local) continue;
                  const castArr: string[] = Array.isArray(m.casting) ? m.casting : [];
                  const dirArr: string[] = Array.isArray(m.direction) ? m.direction : [];
                  local.title    = m.title    || local.title;
                  local.poster   = m.poster   || local.poster;
                  local.direction = dirArr.length  ? dirArr.join(', ')  : local.direction;
                  local.casting  = castArr.length ? castArr.join(', ') : local.casting;
                  local.synopsis = m.synopsis || local.synopsis;
                  local.genres   = m.genres;
                  local.release  = m.release;
                  // boxofficeapi returns runtime in SECONDS — normalize to MINUTES.
                  local.runtime  = typeof m.runtime === 'number'
                    ? Math.round(m.runtime / 60)
                    : undefined;
                  // Store external IDs (altId) so the ratings enricher can
                  // look up AlloCiné IDs for MPDB.
                  if (Array.isArray(m.altId)) {
                    (local as Movie & { altId?: string[] }).altId =
                      m.altId.filter((id: unknown) => typeof id === 'string');
                  }
                }
              }
            }
          } catch {
            // CMB-006: silent fallback — keep placeholders. We deliberately
            // don't propagate the error so one cinema's metadata outage
            // doesn't crash the whole schedule fetch. The main process's
            // per-cinema status will surface this as "metadata partial".
            // (TODO: add a `metadataStatus: 'partial'` field to Movie so the
            // renderer can show a subtle warning badge.)
          }
        }
      }

      const movies = [...moviesById.values()].sort((a, b) =>
        a.title.localeCompare(b.title, 'fr'),
      );

      return { availableDays, movies };
    },
  };
}
