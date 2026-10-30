import { browserFetch } from './browserFetch';
import { pooledFetch } from '../../shared/connectionPool';
import { APP_USER_AGENT } from '../../shared/userAgent';
import { app } from 'electron';
import path from 'path';
import fs from 'fs';
import type { RatingSource, ResolvedIds, RatingFetchResult } from './RatingSource';
import type { Movie } from '../../shared/types';
import { log } from './moduleLoggers';
import { findAllocineIdByTitle } from './wikidataClient';

// ──────────────────────────────────────────────────────────────────────────
// AlloCiné scraper — French press + audience ratings.
//
// Rating extraction (verified from real HTML):
//   The rating is encoded in a CSS class: "rating-mdl n40 stareval-stars"
//   where "n40" means 4.0/5. The pattern is:
//     <span class="rating-title"> Presse </span>
//       ... <div class="rating-mdl n40 stareval-stars">
//     <span class="rating-title"> Spectateurs </span>
//       ... <div class="rating-mdl n35 stareval-stars">
//
//   Vote count: "74 Critiques Spectateurs"
// ──────────────────────────────────────────────────────────────────────────

const ALLOCINE_BASE = 'https://www.allocine.fr';

const HEADERS: Record<string, string> = {
  'User-Agent': APP_USER_AGENT,
  Accept: 'text/html, application/xhtml+xml, application/xml;q=0.9, */*;q=0.8',
  'Accept-Language': 'fr-FR, fr;q=0.5',
};

const DEBUG = process.env.ARVE_DEBUG === '1';

export interface AllocineResult {
  pressRating?: number;
  audienceRating?: number;
  audienceVotes?: number;
  url: string;
  status: 'ok' | 'absent' | 'blocked';
  statusMessage?: string;
}

/** Classify the fetched HTML before trusting a "no ratings" conclusion.
 *
 *  A fichefilm page without the rating widget is NOT proof the film has no
 *  ratings: AlloCiné's bot mitigation sometimes serves a 200 page with the
 *  widget stripped (observed 2026-10-28: a burst of film pages came back
 *  without any rating cards; the same URLs served full pages minutes
 *  later). Recording that as 'absent' poisons the cache for 24h+.
 *
 *  The widget detector matches WIDGET MARKUP (`class="stareval…"`), not the
 *  bare string: every page embeds the `.stareval-note` CSS definition, so a
 *  stripped page still contains the word once.
 *
 *    'has-ratings'      → widget markup present — parse it
 *    'valid-no-ratings' → genuine film page (og:title / ld+json Movie), no
 *                         rating cards — the film really has no ratings
 *    'invalid-page'     → neither: challenge shell, consent wall, error
 *                         page — treat as 'blocked' (retryable) */
export function classifyAllocineHtml(html: string): 'has-ratings' | 'valid-no-ratings' | 'invalid-page' {
  if (/class="[^"]*stareval/.test(html)) return 'has-ratings';
  const looksLikeFilmPage =
    html.includes('property="og:title"') || /"@type"\s*:\s*"Movie"/.test(html);
  return looksLikeFilmPage ? 'valid-no-ratings' : 'invalid-page';
}

export async function fetchAllocineRatings(cfilmId: string): Promise<AllocineResult | null> {
  const url = `${ALLOCINE_BASE}/film/fichefilm_gen_cfilm=${cfilmId}.html`;

  try {
    // Try pooledFetch first — returns the raw server HTML (small, ~50-100 KB).
    // The ratings (rating-mdl CSS classes, stareval-note text) are server-side
    // rendered, so they're in the initial HTML — no JavaScript needed.
    let html = await pooledFetch(url, { headers: HEADERS });

    // If Cloudflare blocked the request, fall back to browserFetch
    // (hidden BrowserWindow solves the challenge automatically).
    if (html.includes('Just a moment...') || html.includes('cf-challenge') || html.length < 200) {
      if (DEBUG)
        log.allocine.info(
          `[allocine] Cloudflare detected on ${cfilmId} — falling back to browserFetch`,
        );
      html = await browserFetch(url, { headers: HEADERS });

      if (html.includes('Just a moment...') || html.includes('cf-challenge')) {
        return {
          url,
          status: 'blocked',
          statusMessage: 'Cloudflare a bloqué la requête',
        };
      }
    } else if (classifyAllocineHtml(html) === 'invalid-page') {
      // 200 but neither a film page nor a recognized challenge — bot mitigation
      // variant. A real browser session may still get the widget.
      if (DEBUG)
        log.allocine.info(
          `[allocine] unrecognized page for ${cfilmId} (${html.length} bytes) — trying browserFetch`,
        );
      const rendered = await browserFetch(url, { headers: HEADERS });
      if (classifyAllocineHtml(rendered) !== 'invalid-page') {
        html = rendered;
      } else {
        return {
          url,
          status: 'blocked',
          statusMessage: 'Réponse AlloCiné non reconnue (protection anti-robot ?)',
        };
      }
    }
    // classifyAllocineHtml(html) === 'valid-no-ratings' → genuine film page
    // without rating cards; fall through to the extraction, which will
    // correctly return 'absent'.

    // In debug mode, save the raw response for inspection.
    if (DEBUG) {
      try {
        const debugDir = path.join(app.getPath('userData'), 'debug');
        fs.mkdirSync(debugDir, { recursive: true });
        const debugFile = path.join(debugDir, `allocine_${cfilmId}.html`);
        fs.writeFileSync(debugFile, html, { encoding: 'utf-8' });
        log.allocine.info(`[allocine] saved response to ${debugFile} (${html.length} bytes)`);
      } catch {
        /* ignore */
      }
    }

    const pressRating = extractRatingBySection(html, 'Presse');
    const audienceRating = extractRatingBySection(html, 'Spectateurs');
    const audienceVotes = extractVoteCount(html);

    if (pressRating === undefined && audienceRating === undefined) {
      return {
        url,
        status: 'absent',
        statusMessage: 'Pas de note presse ni spectateurs sur AlloCiné',
      };
    }

    return {
      pressRating,
      audienceRating,
      audienceVotes,
      url,
      status: 'ok',
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // pooledFetch throws (it does not return bodies) on HTTP errors and on its
    // Cloudflare-challenge detection. Those are transient blocks — record them
    // as 'blocked' (retryable) rather than 'absent' (a fact about the film).
    const blocked = /Cloudflare challenge|HTTP 4[0-9]{2}|HTTP 5[0-9]{2}|TimeoutError/i.test(message);
    return {
      url,
      status: blocked ? 'blocked' : 'absent',
      statusMessage: blocked ? `Requête bloquée : ${message}` : `Erreur réseau : ${message}`,
    };
  }
}

/**
 * Resolve an AlloCiné film code by title.
 *
 * 2026-10-20: AlloCiné retired its server-rendered search `/recherche/?q=`
 * (410 Gone) and replaced it with a client-rendered `/rechercher/` shell
 * backed by their user-JWT'd GraphQL API — plain-HTTP scraping of that flow
 * is not viable (see CHANGELOG 2026-10-27 data appendix probe diagnostics).
 * The resolution moved to WIKIDATA: films carry claim P1265 (AlloCiné film
 * ID), and builtin boxofficeapi cinemas carry Allociné codes DIRECTLY in
 * their schedules (idResolver), so this title fallback only serves movies
 * without a schedule-derived id (custom cinemas).
 */
export async function searchAllocineByTitle(
  title: string,
  expectedYear?: number,
): Promise<string | null> {
  try {
    return await findAllocineIdByTitle(title, expectedYear);
  } catch {
    return null;
  }
}

// ── Extraction helpers ─────────────────────────────────────────────────────

/**
 * Extract a rating from an AlloCiné page.
 *
 * Priority (most precise first):
 *   1. stareval-note text → "3,9" (visible number, precise to 0.1)
 *   2. JSON-LD ratingValue → "3.6" (internal precise value)
 *   3. rating-mdl nXX CSS class → n40 = 4.0 (stars display, rounded to 0.5)
 */
export function extractRatingBySection(html: string, sectionLabel: string): number | undefined {
  const labelIdx = html.indexOf(sectionLabel);
  if (labelIdx < 0) return undefined;

  const section = html.slice(labelIdx, labelIdx + 800);

  // Priority 1: stareval-note text content (precise — not the CSS definition)
  // Format: <span class="stareval-note">3,9</span>
  // Skip if it's inside a <style> block (CSS definition)
  const noteMatches = [...section.matchAll(/stareval-note[^>]*>([0-9],[0-9])</g)];
  for (const m of noteMatches) {
    const val = parseFrenchNumber(m[1]);
    if (Number.isFinite(val) && val >= 0 && val <= 5) return val;
  }

  // Priority 2: JSON-LD aggregateRating (precise internal value)
  const ldMatches = [...html.matchAll(/<script type="application\/ld\+json">(.*?)<\/script>/gs)];
  for (const m of ldMatches) {
    const ld = m[1];
    if (!ld.includes('"Movie"') && !ld.includes('"AggregateRating"')) continue;
    const rv = ld.match(/"ratingValue"\s*:\s*"?([0-9.]+)"?/);
    if (rv) {
      const v = parseFrenchNumber(rv[1]);
      if (Number.isFinite(v) && v >= 0 && v <= 5) return v;
      if (Number.isFinite(v) && v > 5 && v <= 10) return v / 2;
    }
  }

  // Priority 3: rating-mdl nXX CSS class (rounded to 0.5 — least precise)
  const m = section.match(/rating-mdl\s+n(\d+)/);
  if (m) {
    const raw = Number(m[1]);
    if (Number.isFinite(raw) && raw >= 0 && raw <= 50) {
      return raw / 10;
    }
  }

  return undefined;
}

/** Extract the audience vote count from "NN Critiques Spectateurs". */
export function extractVoteCount(html: string): number | undefined {
  const m = html.match(/(\d+)\s+Critiques?\s+Spectateurs/);
  if (m) {
    const n = Number(m[1]);
    if (Number.isFinite(n)) return n;
  }
  // Also try "NN notes"
  const m2 = html.match(/(\d[\d\s]*)\s+notes?/);
  if (m2) {
    const n = Number(m2[1].replace(/\s/g, ''));
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function parseFrenchNumber(s: string): number {
  return Number(s.replace(',', '.'));
}

// ── RatingSource implementation ────────────────────────────────────────────

/** AlloCiné rating source — implements the RatingSource interface.
 *  Scrapes press + audience ratings from allocine.fr via browserFetch. */
export const allocineSource: RatingSource = {
  id: 'allocine',
  displayName: 'AlloCiné',

  isAvailable(ids: ResolvedIds, _movie: Movie): boolean {
    // AlloCiné needs either an allocineId or a title to search for.
    return Boolean(ids.allocineId || _movie.title);
  },

  async fetchRating(ids: ResolvedIds, movie: Movie): Promise<RatingFetchResult | null> {
    let acId = ids.allocineId;
    if (!acId) {
      const year = movie.release ? Number(String(movie.release).slice(0, 4)) : undefined;
      acId = (await searchAllocineByTitle(movie.title, year)) ?? undefined;
    }
    if (!acId) {
      return {
        status: 'absent',
        statusMessage: "Pas d'ID AlloCiné trouvé",
      };
    }
    const ac = await fetchAllocineRatings(acId);
    if (!ac) return null;
    return {
      rating: ac.pressRating,
      secondaryRating: ac.audienceRating,
      secondaryVotes: ac.audienceVotes,
      votes: ac.audienceVotes,
      url: ac.url,
      status: ac.status,
      statusMessage: ac.statusMessage,
    };
  },
};
