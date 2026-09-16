import { browserFetch } from './browserFetch';
import { app } from 'electron';
import path from 'path';
import fs from 'fs';

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
  'User-Agent': 'ArveCinema/1.0.0 (cinema schedule app; +https://github.com/local/arvecinema)',
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

export async function fetchAllocineRatings(cfilmId: string): Promise<AllocineResult | null> {
  const url = `${ALLOCINE_BASE}/film/fichefilm_gen_cfilm=${cfilmId}.html`;

  try {
    const html = await browserFetch(url, { headers: HEADERS });

    if (html.includes('Just a moment...') || html.includes('cf-challenge')) {
      return {
        url,
        status: 'blocked',
        statusMessage: 'Cloudflare a bloqué la requête',
      };
    }

    // In debug mode, save the raw response for inspection.
    if (DEBUG) {
      try {
        const debugDir = path.join(app.getPath('userData'), 'debug');
        fs.mkdirSync(debugDir, { recursive: true });
        const debugFile = path.join(debugDir, `allocine_${cfilmId}.html`);
        fs.writeFileSync(debugFile, html, { encoding: 'utf-8' });
        console.log(`[allocine] saved response to ${debugFile} (${html.length} bytes)`);
      } catch { /* ignore */ }
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
    return {
      url,
      status: 'absent',
      statusMessage: `Erreur réseau : ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export async function searchAllocineByTitle(title: string): Promise<string | null> {
  const url = `${ALLOCINE_BASE}/recherche/?q=${encodeURIComponent(title)}`;

  try {
    const html = await browserFetch(url, { headers: HEADERS });

    if (html.includes('Just a moment...') || html.includes('cf-challenge')) {
      console.warn('[allocine] Cloudflare challenge on search');
      return null;
    }

    const m = html.match(/fichefilm_gen_cfilm=(\d+)/);
    return m ? m[1] : null;
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
function extractRatingBySection(html: string, sectionLabel: string): number | undefined {
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
function extractVoteCount(html: string): number | undefined {
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
