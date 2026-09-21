// ──────────────────────────────────────────────────────────────────────────
// cinevox adapter plugin (cinemavox-chamonix.com)
// ──────────────────────────────────────────────────────────────────────────
// The Chamonix Vox cinema (www.cinemavox-chamonix.com) is server-side
// rendered using the same cotecine CMS as cinechateau.fr (Bonneville). The
// HTML structure is similar but the page is encoded in ISO-8859-1 (not
// UTF-8) and the booking URLs embed an EXACT Unix timestamp — so we don't
// need to infer dates from day tabs the way we do for cinechateau.
//
// Booking URL pattern (verified from the scraping spec):
//   /reserver/F<filmId>/D<unix-seconds>/<VF|VO>/<roomId>/
//
// The `D<timestamp>` segment gives us the exact screening start time in
// UTC seconds. We convert it to Europe/Paris for the `day` and `hour` fields
// the renderer expects.
//
// Endpoints:
//   GET {baseUrl}/horaires/  → full HTML schedule page
//
// Config schema (in cinemas.config.json):
//   {
//     "kind": "cinevox",
//     "baseUrl": "https://www.cinemavox-chamonix.com",
//     "schedulePath": "/horaires/"     // optional, defaults to "/horaires/"
//   }
// ──────────────────────────────────────────────────────────────────────────

import * as cheerio from 'cheerio';
import { APP_USER_AGENT } from '../../../shared/userAgent';
import type { CinemaAdapter, Movie, Showtime } from '../types';
import type { CinemaAdapterPlugin, CinemaConfig, ConfigValidationResult } from './plugin';
import { requireString, optionalString, mergeDefaults } from './plugin';
import { ScraperSchemaChangedError } from './cineChateau';
import { toIsoDay, parseShowtimeDate } from '../../../shared/cinema';
import { browserFetch } from '../../ratings/browserFetch';

const HEADERS: Record<string, string> = {
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'fr-FR,fr;q=0.9',
  'User-Agent': APP_USER_AGENT,
};

const UNKNOWN = 'Non spécifié';

// ── Parsers ────────────────────────────────────────────────────────────────

/** Parse "1h45" → 105 (minutes). Returns undefined on parse failure. */
const parseRuntimeMinutes = (s: string): number | undefined => {
  const m = s.trim().match(/(\d{1,3})\s*h\s*(\d{0,2})/i);
  if (!m) return undefined;
  const h = Number(m[1]);
  const min = m[2] ? Number(m[2]) : 0;
  return h * 60 + min;
};

/** Parse a release date from the .hr_dur text.
 *  Patterns supported:
 *    "Sortie : 9 septembre 2026"  → "2026-09-09T00:00:00.000Z"
 *    "Sortie : 09/09/2026"        → "2026-09-09T00:00:00.000Z"
 *    "Sortie : 9 sept. 2026"      → "2026-09-09T00:00:00.000Z"
 *  Returns undefined if no "Sortie :" pattern is found. */
const FRENCH_MONTHS: Record<string, number> = {
  janvier: 0,
  janv: 0,
  jan: 0,
  février: 1,
  fevrier: 1,
  fév: 1,
  fev: 1,
  févr: 1,
  fevr: 1,
  mars: 2,
  mar: 2,
  avril: 3,
  avr: 3,
  mai: 4,
  juin: 5,
  juil: 6,
  juillet: 6,
  août: 7,
  aout: 7,
  septembre: 8,
  sept: 8,
  sep: 8,
  octobre: 9,
  oct: 9,
  novembre: 10,
  nov: 10,
  décembre: 11,
  decembre: 11,
  déc: 11,
  dec: 11,
};

const parseReleaseDate = (s: string): string | undefined => {
  // Try "Sortie : DD/MM/YYYY"
  const dmyMatch = s.match(/Sortie\s*:\s*(\d{1,2})\s*\/\s*(\d{1,2})\s*\/\s*(\d{4})/i);
  if (dmyMatch) {
    const [, dd, mm, yyyy] = dmyMatch;
    return new Date(Date.UTC(Number(yyyy), Number(mm) - 1, Number(dd))).toISOString();
  }
  // Try "Sortie : DD Month YYYY" (with year)
  const frMatch = s.match(/Sortie\s*:\s*(\d{1,2})\s+([a-zéûôà]+\.?)\s+(\d{4})/i);
  if (frMatch) {
    const [, dd, monthStr, yyyy] = frMatch;
    const monthKey = monthStr.toLowerCase().replace(/\.$/, '').replace(/é/g, 'e');
    const monthIdx = FRENCH_MONTHS[monthKey] ?? FRENCH_MONTHS[monthKey.substring(0, 4)];
    if (monthIdx !== undefined) {
      return new Date(Date.UTC(Number(yyyy), monthIdx, Number(dd))).toISOString();
    }
  }
  // Try "Sortie : DD Month" (WITHOUT year — common on cotecine.fr sites)
  // Assume the current year. If the date is more than 6 months in the past,
  // assume next year. This handles films showing in September with "Sortie : 19 août"
  // (released in August of the current year, not next year).
  const frNoYearMatch = s.match(/Sortie\s*:\s*(\d{1,2})\s+([a-zéûôà]+\.?)(?!\s+\d{4})/i);
  if (frNoYearMatch) {
    const [, dd, monthStr] = frNoYearMatch;
    const monthKey = monthStr.toLowerCase().replace(/\.$/, '').replace(/é/g, 'e');
    const monthIdx = FRENCH_MONTHS[monthKey] ?? FRENCH_MONTHS[monthKey.substring(0, 4)];
    if (monthIdx !== undefined) {
      const now = new Date();
      let year = now.getUTCFullYear();
      const monthDiff = (now.getUTCMonth() - monthIdx + 12) % 12;
      if (monthDiff > 6) {
        year++;
      }
      return new Date(Date.UTC(year, monthIdx, Number(dd))).toISOString();
    }
  }
  return undefined;
};

// Regex matching the booking URL pattern:
//   /reserver/F<filmId>/D<unix-seconds>/<VF|VO>/<roomId>/
const BOOKING_URL_RE = /\/reserver\/F(\d+)\/D(\d+)\/(V[FO])\/(\d+)/;

/** Build per-cinema headers: Referer points at THIS cinema's origin. */
const buildHeaders = (baseUrl: string): Record<string, string> => ({
  ...HEADERS,
  Referer: baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`,
});

// ── Plugin definition ──────────────────────────────────────────────────────

const plugin: CinemaAdapterPlugin = {
  id: 'cinevox',
  displayName: 'CineVox (cotecine CMS)',
  description:
    'HTML scraper for cinemavox-chamonix.com — cotecine CMS with ISO-8859-1 encoding and booking URL timestamp resolution',

  defaultConfig: {
    schedulePath: '/horaires/',
  },

  validateConfig(config: CinemaConfig): ConfigValidationResult {
    const errors: string[] = [];
    try {
      requireString(config, 'baseUrl');
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
    }
    if (errors.length > 0) return { ok: false, errors };
    return { ok: true, config: mergeDefaults(config, plugin.defaultConfig) };
  },

  createAdapter(cinemaId: string, config: CinemaConfig): CinemaAdapter {
    const baseUrl = requireString(config, 'baseUrl');
    const schedulePath = optionalString(config, 'schedulePath', '/horaires/');

    return {
      async fetchSchedule(_windowDays: number) {
        // Use browserFetch (hidden BrowserWindow) instead of plain fetchWithTimeout.
        // cinemavox-chamonix.com may add Cloudflare protection at any time.
        // browserFetch runs real Chromium JS which solves Cloudflare challenges
        // automatically.
        const html = await browserFetch(`${baseUrl}${schedulePath}`, {
          headers: buildHeaders(baseUrl),
        });
        const $ = cheerio.load(html);

        const resolveUrl = (maybeRelative: string | undefined): string | undefined => {
          if (!maybeRelative) return undefined;
          try {
            return new URL(maybeRelative, baseUrl).toString();
          } catch {
            return undefined;
          }
        };

        // ── Phase 1: collect day sequence from the FIRST .hr_film's header.
        // The page contains 13 day tabs (jour1..jour13). We don't actually need
        // to resolve them by name — the booking URL carries the real timestamp.
        // But we still need the day labels to populate `availableDays`, so we
        // resolve them using the same monotonic-day algorithm as cinechateau.

        const firstFilmHeader = $('.hr_film').first().find('.lesjours .fcel');
        const dayEntries: { jourClass: string; dayNum: number; weekday: string }[] = [];

        firstFilmHeader.each((_, el) => {
          const classes = ($(el).attr('class') || '').split(/\s+/);
          const jourClass = classes.find((c) => c.startsWith('jour'));
          if (!jourClass) return;
          const weekday = $(el).find('.nom_jour').text().trim().replace(/\.$/, '');
          const dayNumStr = $(el)
            .find('a')
            .text()
            .trim()
            .replace(/^.*?(\d+)$/, '$1');
          const dayNum = Number(dayNumStr);
          if (!dayNum) return;
          dayEntries.push({ jourClass, dayNum, weekday });
        });

        // We don't reuse cinechateau's `resolveDaySequence` because the booking
        // URL gives us the real timestamp — we only need a coarse day map to
        // populate `availableDays`. We compute it lazily from showtimes below.

        // ── Phase 2: parse each .hr_film block.
        const movies: Movie[] = [];
        const allDays = new Set<string>();

        $('.hr_film').each((_, filmEl) => {
          const $film = $(filmEl);
          const titleLink = $film.find('h2 > a').first();
          const title = titleLink.text().trim();
          if (!title) return;
          const filmHref = titleLink.attr('href') || '';
          const idMatch = filmHref.match(/\/film\/(\d+)\//);
          const externalId = idMatch ? idMatch[1] : `vox-${movies.length + 1}`;

          const poster = resolveUrl($film.find('img.hr_aff').first().attr('src'));
          const direction = $film.find('.hr_real strong').text().trim() || UNKNOWN;
          const castingText = $film.find('.hr_cast').text().trim();
          const casting = castingText.replace(/^Avec\s*/i, '').trim() || UNKNOWN;
          const genres = $film.find('.genre strong').text().trim() || undefined;
          const durText = $film.find('.hr_dur').text();
          const runtime = parseRuntimeMinutes(durText);
          const release = parseReleaseDate(durText);

          const showtimes: Showtime[] = [];
          let hasVF = false;
          let hasVO = false;

          $film.find('.tab_seances').each((_, tabEl) => {
            const $tab = $(tabEl);
            const classes = ($tab.attr('class') || '').split(/\s+/);
            const jourClass = classes.find((c) => c.startsWith('jour'));
            if (!jourClass) return;
            // We don't trust the jourN→date mapping; we use the booking URL's
            // timestamp instead. The jourClass is only used as a sanity check.

            $tab.find('.frow').each((_, rowEl) => {
              const $row = $(rowEl);
              // Per-row version detection (same approach as cinechateau — see
              // detectRowVersion in cineChateauAdapter.ts).
              let rowIsVF = false;
              let rowIsVO = false;
              $row.find('.celtags img').each((_, imgEl) => {
                const cls = ($(imgEl).attr('class') || '').toLowerCase();
                const src = ($(imgEl).attr('src') || '').toLowerCase();
                const file = src.split('/').pop() ?? '';
                if (
                  /\b(vostfr|vost|vo)\b/.test(file) ||
                  cls.includes('tag-vost') ||
                  cls.includes('tag-vo')
                ) {
                  rowIsVO = true;
                } else if (/\bvf\b/.test(file) || cls.includes('tag-vf')) {
                  rowIsVF = true;
                }
              });
              if (rowIsVF) hasVF = true;
              if (rowIsVO) hasVO = true;

              $row.find('a.seance').each((_, seanceEl) => {
                const $s = $(seanceEl);
                const href = resolveUrl($s.attr('href') || undefined);
                if (!href) return;

                // The booking URL contains the exact Unix timestamp.
                const m = BOOKING_URL_RE.exec(href);
                if (!m) return;
                const [, , tsStr, versionFromUrl] = m;
                const ts = Number(tsStr);
                if (!Number.isFinite(ts)) return;

                // The timestamp is in UTC seconds. Convert to Europe/Paris.
                const d = parseShowtimeDate(new Date(ts * 1000).toISOString());
                if (!d) return;

                // Override version detection from the URL if available — the
                // URL is more reliable than the .celtags img (which can be
                // missing on some rows).
                const tags: string[] = [];
                if (versionFromUrl === 'VO') {
                  tags.push('Localization.Version.Original');
                } else if (versionFromUrl === 'VF') {
                  tags.push('Localization.Language.French');
                } else {
                  if (rowIsVF) tags.push('Localization.Language.French');
                  if (rowIsVO) tags.push('Localization.Version.Original');
                }

                const hour = d.getHours() + d.getMinutes() / 60;
                const day = toIsoDay(d);
                allDays.add(day);

                // Try to extract the screen name from the .infos_seance img.
                let screen: string | undefined;
                $s.find('.infos_seance img').each((_, imgEl) => {
                  const cls = $(imgEl).attr('class') || '';
                  if (cls.includes('tag-SAL')) {
                    screen = $(imgEl).attr('alt') || undefined || screen;
                  }
                });

                showtimes.push({
                  time: d.toISOString(),
                  hour,
                  day,
                  tags,
                  screen,
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
            title,
            poster,
            direction,
            casting,
            synopsis: undefined,
            genres,
            runtime,
            release,
            hasVF,
            hasVO,
            showtimes,
          });
        });

        // CMB-016 / BUG-02 invariant — surface a clear failure if the page
        // structure changed and we got zero movies despite finding day tabs.
        if (dayEntries.length > 0 && movies.length === 0) {
          throw new ScraperSchemaChangedError(
            `${cinemaId}: page has ${dayEntries.length} day tabs but 0 .hr_film blocks — ` +
              `selector schema likely changed`,
          );
        }

        movies.sort((a, b) => a.title.localeCompare(b.title, 'fr'));
        const availableDays = [...allDays].sort();
        return { availableDays, movies };
      },
    };
  },
};

export default plugin;

// ── Backward-compatible factory ─────────────────────────────────────────────

export interface CineVoxConfig {
  baseUrl: string;
  schedulePath?: string;
}

/** Build a CineVox adapter for one cinema.
 *  @deprecated use the plugin's `createAdapter()` directly via the registry. */
export function createCineVoxAdapter(cinemaId: string, cfg: CineVoxConfig): CinemaAdapter {
  // Inject the `kind` field for the new plugin contract (backward compat).
  return plugin.createAdapter(cinemaId, { kind: 'cinevox', ...cfg });
}
