import * as cheerio from 'cheerio';
import { APP_USER_AGENT } from '../../shared/userAgent';
import type { CinemaAdapter, Movie, Showtime } from './types';
import { WEEKDAY_FR } from '../../shared/cinema';
import { toIsoDay } from '../../shared/cinema';
import { fetchWithTimeout, REQUEST_TIMEOUT_MS } from '../../shared/fetchWithTimeout';

// ──────────────────────────────────────────────────────────────────────────
// Error types
// ──────────────────────────────────────────────────────────────────────────

/** Thrown when the Ciné Château HTML no longer matches the selectors we
 *  expect, or when the day sequence can't be resolved monotonically.
 *  Surfaces as a per-cinema failure in the main process's IPC handler so the
 *  user sees "Ciné Château — scraper schema changed" instead of a silent
 *  empty schedule.
 *
 *  Declared at the TOP of the file because it's referenced by `resolveDaySequence`
 *  below. Class declarations are hoisted in JS, so this would work regardless,
 *  but keeping the declaration above its first use is less fragile. */
export class ScraperSchemaChangedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScraperSchemaChangedError';
  }
}

// ──────────────────────────────────────────────────────────────────────────
// cinechateau.fr adapter (Bonneville)
// ──────────────────────────────────────────────────────────────────────────
// The Bonneville cinema (www.cinechateau.fr) is server-side rendered: the
// schedule page at /horaires/ contains the full week's data in HTML. There is
// no JSON API, so we scrape the HTML directly.
//
// Structure (verified from a real page snapshot):
//   .hr_film              — one per movie
//     h2 > a[href]        — movie title + link to film page
//     img.hr_aff          — poster URL
//     .hr_p.hr_dur        — "Durée : 1h45 - Sortie : 9 septembre"
//     .hr_p.hr_real       — "Réalisé par <strong>Name</strong>"
//     .hr_p.hr_cast       — "Avec ..."
//     .hr_p.genre          — "Genre : <strong>Drame, Historique</strong>"
//   .hr_tablehor
//     .lesjours           — list of .fcel.jourN > a > .nom_jour + day number
//     .tab_seances.jourN  — showtimes for day N
//       .seance.hr_seance — <a href="..."><span class="hor">14h00</span></a>
//       .celtags img.tag  — VF/VO tag image (tag_vf_new.png = VF, etc.)
//
// Runtime note: the page exposes runtime in MINUTES already, so no
// normalization is needed (unlike boxofficeapi which returns seconds).
// ──────────────────────────────────────────────────────────────────────────

export interface CineChateauConfig {
  baseUrl: string;         // e.g. "https://www.cinechateau.fr"
  schedulePath?: string;   // defaults to "/horaires/"
}

const HEADERS: Record<string, string> = {
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'User-Agent': APP_USER_AGENT,
};

/** Placeholder used when the page doesn't expose a value. */
const UNKNOWN = 'Non spécifié';

// ── Parsers ────────────────────────────────────────────────────────────────

/** Parse "14h00" / "14h" / "14:00" → hour float (14.0). Returns null on parse failure
 *  or out-of-range values. */
const parseHour = (s: string): number | null => {
  const m = s.trim().match(/^(\d{1,2})\s*[h:]\s*(\d{0,2})$/i);
  if (!m) return null;
  const h = Number(m[1]);
  const min = m[2] ? Number(m[2]) : 0;
  if (Number.isNaN(h) || Number.isNaN(min)) return null;
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h + min / 60;
};

/** Parse "1h45" → 105 (minutes). Returns undefined on parse failure. */
const parseRuntimeMinutes = (s: string): number | undefined => {
  const m = s.trim().match(/(\d{1,3})\s*h\s*(\d{0,2})/i);
  if (!m) return undefined;
  const h = Number(m[1]);
  const min = m[2] ? Number(m[2]) : 0;
  return h * 60 + min;
};

// ── Version-tag detection (BUG-05 + BUG-06) ────────────────────────────────
//
// Previously: `src.includes('vo')` matched ANY URL containing those two letters
// (/video/, /promo/, hashes with "vo" in them, etc.), and the version was
// detected once per `.tab_seances` day column, so every showtime in that day
// got the same tags — a Saturday with a 14h VF matinée and a 21h VO evening
// would have both tags applied to both showtimes.
//
// Now: regex anchored on the filename (basename, not full URL), and the
// detection is done per-ROW inside the day tab, so each .seance inherits
// its own row's version tag.
//
// Note: `\bvf\b` alone wouldn't match `tag_vf_new.png` because underscore
// is a word character in regex, so the `\b` between `tag_` and `vf` doesn't
// fire. The `tag_vf` and `tho_vost` literal fallbacks cover the actual
// filenames used by cinechateau.fr.

const VO_TAG_RE = /\b(vostfr|vost|vo)\b|tho_vost/i;
const VF_TAG_RE = /\bvf\b|tag_vf/i;

interface RowVersion { isVF: boolean; isVO: boolean; }

const detectRowVersion = ($: cheerio.CheerioAPI, $row: cheerio.Cheerio<any>): RowVersion => {
  let isVF = false;
  let isVO = false;
  $row.find('.celtags img').each((_, imgEl) => {
    const src = ($(imgEl).attr('src') || '').toLowerCase();
    const alt = ($(imgEl).attr('alt') || '').toLowerCase();
    // Match on the FILENAME only — the full path can legitimately contain
    // "vo" in /video/, /wp-content/uploads/, etc.
    const file = src.split('/').pop() ?? '';
    if (VO_TAG_RE.test(file) || alt.includes('original')) {
      isVO = true;
    } else if (VF_TAG_RE.test(file) || /fran[cç]ais/.test(alt)) {
      isVF = true;
    }
  });
  return { isVF, isVO };
};

/**
 * Infer the YYYY-MM-DD anchor date by searching ±14 days around today for
 * the closest match on (dayNum, weekday). Used only for the FIRST day tab;
 * subsequent tabs are resolved by `resolveDaySequence` walking forward.
 */
const inferAnchorDate = (
  dayNum: number,
  weekdayShortFr: string,
  searchWindowDays = 14,
): string | null => {
  const wd = WEEKDAY_FR.findIndex(w => weekdayShortFr.toLowerCase().startsWith(w));
  if (wd < 0) return null;
  const today = new Date();
  let best: { date: Date; distance: number } | null = null;
  for (let i = -searchWindowDays; i <= searchWindowDays; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() + i);
    if (d.getDate() === dayNum && d.getDay() === wd) {
      const distance = Math.abs(i);
      if (!best || distance < best.distance) {
        best = { date: new Date(d), distance };
      }
    }
  }
  return best ? toIsoDay(best.date) : null;
};

/** Add N days to a YYYY-MM-DD string and return YYYY-MM-DD. */
const addDays = (isoDay: string, days: number): string => {
  const d = new Date(`${isoDay}T12:00:00Z`);   // noon UTC avoids DST edge cases
  d.setUTCDate(d.getUTCDate() + days);
  return toIsoDay(d);
};

/**
 * Resolve each day tab independently but monotonically — never jumps
 * backward, never skips more than 8 days (catches gaps loudly).
 *
 * Background — the previous "anchor + i" algorithm assumed the day tabs
 * were strictly consecutive. If the cinema is closed one day and the
 * page omits that tab (or the tabs run Wed–Tue across a gap), every
 * day after the gap was off by one or more. The parsed `(dayNum, weekday)`
 * for tabs 2..N was collected and then thrown away, so the code had the
 * evidence to detect this and didn't use it.
 *
 * BUG-02 fix — walk forward from the previous day, bounded at 8 days,
 * until both dayNum AND weekday match. If no match within 8 days,
 * throw `ScraperSchemaChangedError` so the user sees a clear failure
 * rather than silently-misdated showtimes.
 */
const resolveDaySequence = (
  entries: { jourClass: string; dayNum: number; weekday: string }[],
  cinemaId: string,
): Map<string, string> => {
  const map = new Map<string, string>();
  if (entries.length === 0) return map;

  let cursor = inferAnchorDate(entries[0].dayNum, entries[0].weekday);
  if (!cursor) {
    throw new ScraperSchemaChangedError(
      `${cinemaId}: could not resolve first day tab (${entries[0].weekday} ${entries[0].dayNum})`,
    );
  }
  map.set(entries[0].jourClass, cursor);

  for (let i = 1; i < entries.length; i++) {
    const { jourClass, dayNum, weekday } = entries[i];
    const wd = WEEKDAY_FR.findIndex(w => weekday.toLowerCase().startsWith(w));
    if (wd < 0) {
      throw new ScraperSchemaChangedError(
        `${cinemaId}: could not parse weekday "${weekday}" for ${jourClass}`,
      );
    }
    // Walk forward from `cursor`, 1 to 8 days, until we find a date that
    // matches BOTH day-of-month AND weekday. Bounded search catches
    // genuinely broken pages instead of looping or jumping weeks.
    let found: string | null = null;
    for (let step = 1; step <= 8; step++) {
      const cand = addDays(cursor, step);
      const cd = new Date(`${cand}T12:00:00Z`);
      if (cd.getUTCDate() === dayNum && cd.getUTCDay() === wd) {
        found = cand;
        break;
      }
    }
    if (!found) {
      throw new ScraperSchemaChangedError(
        `${cinemaId}: could not resolve ${jourClass} (${weekday} ${dayNum}) after ${cursor}`,
      );
    }
    map.set(jourClass, found);
    cursor = found;
  }
  return map;
};

// ── Adapter factory ────────────────────────────────────────────────────────

export function createCineChateauAdapter(
  cinemaId: string,
  cfg: CineChateauConfig,
): CinemaAdapter {
  const schedulePath = cfg.schedulePath ?? '/horaires/';

  return {
    async fetchSchedule(windowDays: number) {
      // Network call with timeout — see shared/fetchWithTimeout.
      const res = await fetchWithTimeout(
        `${cfg.baseUrl}${schedulePath}`,
        { headers: HEADERS },
        REQUEST_TIMEOUT_MS,
      );
      if (!res.ok) throw new Error(`${cinemaId}: HTTP ${res.status}`);
      // Consume the response body as ArrayBuffer ONCE, then decode.
      // cinechateau.fr is served as ISO-8859-1. If we decode as UTF-8,
      // accented characters become replacement chars (�). Detect and
      // re-decode from the same bytes.
      const buf = await res.arrayBuffer();
      let html = new TextDecoder('utf-8').decode(buf);
      if (html.includes('\uFFFD')) {
        html = new TextDecoder('iso-8859-1').decode(buf);
      }
      const $ = cheerio.load(html);

      // 1. Collect jourN → (dayNum, weekday) pairs from the FIRST .hr_film's
      //    header. Each movie block has its own copy of the day header, but
      //    they should all be identical — picking the first avoids collecting
      //    N×14 duplicates and wasting time on redundant lookups.
      const firstFilmHeader = $('.hr_film').first().find('.lesjours .fcel');
      const dayEntries: { jourClass: string; dayNum: number; weekday: string }[] = [];

      firstFilmHeader.each((_, el) => {
        const classes = ($(el).attr('class') || '').split(/\s+/);
        const jourClass = classes.find(c => c.startsWith('jour'));
        if (!jourClass) return;
        const weekday = $(el).find('.nom_jour').text().trim().replace(/\.$/, '');
        const dayNumStr = $(el).find('a').text().trim().replace(/^.*?(\d+)$/, '$1');
        const dayNum = Number(dayNumStr);
        if (!dayNum) return;
        dayEntries.push({ jourClass, dayNum, weekday });
      });

      // Resolve the day sequence with per-tab validation (BUG-02 fix).
      // Throws ScraperSchemaChangedError if any tab can't be matched
      // monotonically — better to surface a clear failure than silently
      // misdate every showtime after a gap.
      const dayMap = resolveDaySequence(dayEntries, cinemaId);
      const allParsedDays = [...dayMap.values()];

      // 2. Parse each .hr_film block.
      const movies: Movie[] = [];
      const baseUrl = cfg.baseUrl;

      const resolveUrl = (maybeRelative: string | undefined): string | undefined => {
        if (!maybeRelative) return undefined;
        try {
          return new URL(maybeRelative, baseUrl).toString();
        } catch {
          return undefined;
        }
      };

      $('.hr_film').each((_, filmEl) => {
        const $film = $(filmEl);
        const titleLink = $film.find('h2 > a').first();
        const title = titleLink.text().trim();
        if (!title) return;
        const filmHref = titleLink.attr('href') || '';
        // Extract numeric movie id from URL like /film/596322/.
        const idMatch = filmHref.match(/\/film\/(\d+)\//);
        const externalId = idMatch ? idMatch[1] : `bc-${movies.length + 1}`;

        // CMB-017: resolve poster URL against the cinema's base URL in case
        // the website uses a relative path.
        const poster = resolveUrl($film.find('img.hr_aff').first().attr('src'));
        const direction = $film.find('.hr_real strong').text().trim() || UNKNOWN;
        const castingText = $film.find('.hr_cast').text().trim();
        const casting = castingText.replace(/^Avec\s*/i, '').trim() || UNKNOWN;
        const genres = $film.find('.genre strong').text().trim() || undefined;
        const runtime = parseRuntimeMinutes($film.find('.hr_dur').text());

        // 2a. Walk each .tab_seances.jourN to collect showtimes.
        const showtimes: Showtime[] = [];
        let hasVF = false;
        let hasVO = false;

        $film.find('.tab_seances').each((_, tabEl) => {
          const $tab = $(tabEl);
          const classes = ($tab.attr('class') || '').split(/\s+/);
          const jourClass = classes.find(c => c.startsWith('jour'));
          if (!jourClass) return;
          const day = dayMap.get(jourClass);
          if (!day) return;

          // BUG-05 fix: walk each .frow individually and detect the version
          // tag per row, so a day mixing VF + VO doesn't conflate them.
          // Previously, all .celtags img in the tab were combined, and every
          // showtime in the day got the same tags.
          $tab.find('.frow').each((_, rowEl) => {
            const $row = $(rowEl);
            const { isVF: rowIsVF, isVO: rowIsVO } = detectRowVersion($, $row);
            if (rowIsVF) hasVF = true;
            if (rowIsVO) hasVO = true;

            $row.find('.seance').each((_, seanceEl) => {
              const $s = $(seanceEl);
              const href = resolveUrl($s.attr('href') || undefined);
              const timeStr = $s.find('.hor').text().trim();
              const hour = parseHour(timeStr);
              if (hour === null) return;

              // Mirror the boxofficeapi tag convention so the renderer's
              // isVFShowtime / isVOShowtime helpers work uniformly.
              const tags: string[] = [];
              if (rowIsVF) tags.push('Localization.Language.French');
              if (rowIsVO) tags.push('Localization.Version.Original');

              // Reconstruct an ISO-ish local time (no tz designator): the
              // page doesn't give us one, so we build YYYY-MM-DDThh:mm:00.
              const hh = String(Math.floor(hour)).padStart(2, '0');
              const mm = String(Math.round((hour % 1) * 60)).padStart(2, '0');
              const timeIso = `${day}T${hh}:${mm}:00`;

              showtimes.push({
                time: timeIso,
                hour, day, tags,
                screen: undefined,    // cinechateau doesn't expose screen name in the HTML
                ticketingUrl: href,
                cinemaId,
              });
            });
          });
        });

        if (showtimes.length === 0) return;
        showtimes.sort((a, b) => a.time.localeCompare(b.time));

        movies.push({
          id: externalId,
          cinemaId,
          title, poster, direction, casting,
          synopsis: undefined,    // not on the schedule page
          genres, runtime,
          hasVF, hasVO,
          showtimes,
        });
      });

      movies.sort((a, b) => a.title.localeCompare(b.title, 'fr'));

      // CMB-016 — scraper-schema invariant: if we found day tabs in the header
      // but zero movie blocks, the website has been redesigned and our
      // selectors are stale. Throw a typed error rather than returning an
      // empty schedule (which would look like "no screenings this week").
      if (dayEntries.length > 0 && movies.length === 0) {
        throw new ScraperSchemaChangedError(
          `${cinemaId}: page has ${dayEntries.length} day tabs but 0 .hr_film blocks — ` +
          `selector schema likely changed`,
        );
      }

      // CMB-012 — respect the adapter contract: trim parsed days to the
      // requested window. We sort the union of allParsedDays + filter by date
      // range relative to today.
      const today = toIsoDay(new Date());
      const windowEnd = addDays(today, Math.max(0, windowDays));
      const availableDays = allParsedDays
        .filter(d => d >= today && d <= windowEnd)
        .sort();

      return { availableDays, movies };
    },
  };
}

