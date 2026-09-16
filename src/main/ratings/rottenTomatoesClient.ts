import { pooledFetch } from '../../shared/connectionPool';

// ──────────────────────────────────────────────────────────────────────────
// Rotten Tomatoes scraper — press Tomatometer only.
//
// Uses the connection pool with a 2-second delay between requests.
// ──────────────────────────────────────────────────────────────────────────

const RT_BASE = 'https://www.rottentomatoes.com';
const RT_UA = 'ArveCinema/1.0.0 (+https://github.com/local/arvecinema)';

const HEADERS: Record<string, string> = {
  'User-Agent': RT_UA,
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7',
};

/** Delay between consecutive requests to rottentomatoes.com. */
const RT_DELAY_MS = 2000;

export interface RtResult {
  tomatometer?: number;
  certifiedFresh?: boolean;
  url: string;
  status: 'ok' | 'absent' | 'blocked';
  statusMessage?: string;
}

export async function fetchRtRatings(rtPath: string): Promise<RtResult | null> {
  const path = rtPath.startsWith('/') ? rtPath : `/${rtPath}`;
  const url = `${RT_BASE}${path}`;

  try {
    const html = await pooledFetch(url, {
      headers: HEADERS,
      domainDelayMs: RT_DELAY_MS,
    });

    const tomatometer = extractTomatometer(html);
    const certifiedFresh = extractCertifiedFresh(html);

    if (tomatometer === undefined) {
      return {
        url,
        status: 'absent',
        statusMessage: 'Pas de Tomatometer sur la page RT',
      };
    }

    return {
      tomatometer,
      certifiedFresh,
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

// ── Extraction helpers ─────────────────────────────────────────────────────

/** Extract the tomatometer using JSON-LD (the film's own rating, not
 *  recommendation carousel values). */
function extractTomatometer(html: string): number | undefined {
  const ldMatches = [...html.matchAll(/<script type="application\/ld\+json">(.*?)<\/script>/gs)];
  for (const m of ldMatches) {
    const ld = m[1];
    if (!ld.includes('"Movie"')) continue;
    const rv = ld.match(/"ratingValue":"?(\d+)/);
    if (rv) {
      const v = Number(rv[1]);
      if (Number.isFinite(v) && v >= 0 && v <= 100) return v;
    }
  }

  // Fallback: first tomatometer BEFORE "moreLikeThis" section
  const moreLikeThisIdx = html.indexOf('moreLikeThis');
  const searchZone = moreLikeThisIdx > 0 ? html.slice(0, moreLikeThisIdx) : html;
  const m1 = searchZone.match(/"tomatometer":(\d+)/);
  if (m1) {
    const v = Number(m1[1]);
    if (Number.isFinite(v) && v >= 0 && v <= 100) return v;
  }

  return undefined;
}

function extractCertifiedFresh(html: string): boolean {
  return html.includes('"certifiedFresh":"certified"')
    || html.includes('"certified":true')
    || html.includes('certified-fresh');
}
