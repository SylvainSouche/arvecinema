// ──────────────────────────────────────────────────────────────────────────
// ⚠️  SLEEPING BACKUP — NOT USED IN ACTIVE CODE  ⚠️
//
// This file implements per-film IMDB ratings scraping via a hidden
// BrowserWindow. It loads each imdb.com title page, extracts the rating
// from JSON-LD, and returns it.
//
// As of v0.5.0, this approach has been RETIRED in favor of `imdbDatasetClient.ts`,
// which uses IMDB's official public dataset (https://datasets.imdbws.com/
// title.ratings.tsv.gz) — a daily-refreshed SQLite-backed local cache.
//
// This file remains in the tree as a sleeping backup. If the dataset
// becomes unavailable in the future, re-enable by importing `fetchImdbRating`
// from this module in `ratingsEnricher.ts` and re-adding the fallback path
// in the Phase 2 IMDB section (currently removed).
//
// Reasons for retirement:
//   1. Per-film browserFetch is ~50× slower than dataset lookup
//   2. Susceptible to imdb.com page-structure changes (CSS class churn)
//   3. Triggers hidden BrowserWindow opens for every film (~2-5s each)
//   4. The dataset is more reliable (1.71M rated titles, daily refresh)
// ──────────────────────────────────────────────────────────────────────────

import { browserFetch } from './browserFetch';
import { APP_USER_AGENT } from '../../shared/userAgent';
import { app } from 'electron';
import path from 'path';
import fs from 'fs';
import { log } from './moduleLoggers';

// ──────────────────────────────────────────────────────────────────────────
// IMDB scraper — uses a hidden BrowserWindow to bypass Cloudflare.
//
// The page is loaded in a real Chromium browser (bundled with Electron),
// JavaScript runs, the Cloudflare challenge auto-resolves, and we extract
// the rating from the JSON-LD.
// ──────────────────────────────────────────────────────────────────────────

const IMDB_BASE = 'https://www.imdb.com';

const DEBUG = process.env.ARVE_DEBUG === '1';

export interface ImdbResult {
  rating?: number;
  votes?: number;
  url: string;
  status: 'ok' | 'absent' | 'blocked';
  statusMessage?: string;
}

export async function fetchImdbRating(imdbId: string): Promise<ImdbResult | null> {
  const url = `${IMDB_BASE}/title/${imdbId}/`;

  try {
    const html = await browserFetch(url, {
      headers: {
        'User-Agent': APP_USER_AGENT,
      },
    });

    // In debug mode, save the raw response for inspection.
    if (DEBUG) {
      try {
        const debugDir = path.join(app.getPath('userData'), 'debug');
        fs.mkdirSync(debugDir, { recursive: true });
        const debugFile = path.join(debugDir, `imdb_${imdbId}.html`);
        fs.writeFileSync(debugFile, html, { encoding: 'utf-8' });
        log.imdbScraper.debug(`saved response to ${debugFile} (${html.length} bytes)`);
      } catch {
        /* ignore */
      }
    }

    return parseImdbHtml(html, url);
  } catch (err) {
    return {
      url,
      status: 'absent',
      statusMessage: `Erreur : ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

function parseImdbHtml(html: string, url: string): ImdbResult {
  // Extract rating from JSON-LD
  const ldMatches = [...html.matchAll(/<script type="application\/ld\+json">(.*?)<\/script>/gs)];
  for (const m of ldMatches) {
    const ld = m[1];
    if (!ld.includes('"Movie"') && !ld.includes('"@type":"Movie"')) continue;

    // Parse the JSON-LD properly to avoid matching bestRating/worstRating
    // instead of the actual ratingValue.
    try {
      const parsed = JSON.parse(ld);
      // IMDB JSON-LD structure:
      //   { "@type": "Movie", "aggregateRating": {
      //       "@type": "AggregateRating",
      //       "ratingValue": "7.8",   ← THIS is what we want
      //       "ratingCount": "245678",
      //       "bestRating": "10",
      //       "worstRating": "1"
      //   }}
      const agg = parsed.aggregateRating;
      if (agg && agg.ratingValue !== undefined) {
        const rating = Number(agg.ratingValue);
        const votes = agg.ratingCount !== undefined ? Number(agg.ratingCount) : undefined;
        if (Number.isFinite(rating) && rating >= 0 && rating <= 10) {
          return {
            rating,
            votes: Number.isFinite(votes) ? votes : undefined,
            url,
            status: 'ok',
          };
        }
      }
    } catch {
      // JSON.parse failed — fall through to regex
    }

    // Regex fallback: match ratingValue that's NOT bestRating/worstRating
    // by looking for it inside an aggregateRating context
    const aggMatch = ld.match(/"aggregateRating"\s*:\s*\{[^}]*?"ratingValue"\s*:\s*"?([0-9.]+)"?/);
    if (aggMatch) {
      const rating = Number(aggMatch[1]);
      const rc = ld.match(/"ratingCount"\s*:\s*"?(\d+)"/);
      const votes = rc ? Number(rc[1]) : undefined;
      if (Number.isFinite(rating) && rating >= 0 && rating <= 10) {
        return {
          rating,
          votes: Number.isFinite(votes) ? votes : undefined,
          url,
          status: 'ok',
        };
      }
    }
  }

  // Fallback: data-testid rating (newer IMDB layout)
  const m2 = html.match(/data-testid="rating-bar__aggregate-rating"[^>]*>[^<]*<[^>]*>([0-9.]+)/);
  if (m2) {
    const rating = Number(m2[1]);
    if (Number.isFinite(rating) && rating >= 0 && rating <= 10) {
      return { rating, url, status: 'ok' };
    }
  }

  // If the page is very short, it's probably still a challenge page
  if (html.length < 5000) {
    return {
      url,
      status: 'blocked',
      statusMessage: `Page trop petite (${html.length} bytes) — challenge non résolu`,
    };
  }

  return {
    url,
    status: 'absent',
    statusMessage: `Pas de note IMDB trouvée sur la page (${html.length} bytes)`,
  };
}
