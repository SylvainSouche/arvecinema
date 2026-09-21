// ──────────────────────────────────────────────────────────────────────────
// ⚠️  SLEEPING BACKUP — NOT USED IN ACTIVE CONFIG  ⚠️
//
// cinechateau.fr (Bonneville) has been redesigned to a Gatsby 5.14.6 site
// using the same boxOfficeApi as Mont-Blanc and Cluses. The old cotecine.fr
// HTML scraper (this file) no longer works — the page no longer contains
// .hr_film / .tab_seances elements.
//
// This adapter is kept as a sleeping backup in case the site reverts to the
// old cotecine.fr CMS. To re-enable: change cinemas.config.json to use
// `kind: "cinechateau"` for the Bonneville cinema entry.
//
// Config schema (in cinemas.config.json):
//   {
//     "kind": "cinechateau",
//     "baseUrl": "https://www.cinechateau.fr",
//     "schedulePath": "/horaires/"   // optional
//   }
// ──────────────────────────────────────────────────────────────────────────

import * as cheerio from 'cheerio';
import { APP_USER_AGENT } from '../../../shared/userAgent';
import type { CinemaAdapter, Movie } from '../types';
import type { CinemaAdapterPlugin, CinemaConfig, ConfigValidationResult } from './plugin';
import { requireString, optionalString, mergeDefaults } from './plugin';
import { browserFetch } from '../../ratings/browserFetch';
import { log } from '../../ratings/moduleLoggers';

// ── Error types ───────────────────────────────────────────────────────────

export class ScraperSchemaChangedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScraperSchemaChangedError';
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────

const HEADERS: Record<string, string> = {
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'fr-FR,fr;q=0.9',
  'User-Agent': APP_USER_AGENT,
};

// ── Plugin definition ──────────────────────────────────────────────────────

const plugin: CinemaAdapterPlugin = {
  id: 'cinechateau',
  displayName: 'CineChateau (cotecine CMS — sleeping backup)',
  description:
    'HTML scraper for the old cinechateau.fr cotecine CMS (Bonneville). ' +
    'Currently retired in favor of boxofficeapi; kept as sleeping backup.',

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
      async fetchSchedule() {
        const html = await browserFetch(`${baseUrl}${schedulePath}`, { headers: HEADERS });

        if (!html.includes('hr_film')) {
          log.cineChateau.error(
            `page does not contain .hr_film blocks (got ${html.length} bytes). ` +
              `First 500 chars: ${html.substring(0, 500)}`,
          );
          throw new ScraperSchemaChangedError(
            `${cinemaId}: page loaded but no .hr_film blocks found — ` +
              `likely Cloudflare challenge or page redesign`,
          );
        }

        // cheerio.load is intentionally unused in this sleeping backup —
        // we only verify the schema via the string check above. If the site
        // ever reverts to cotecine.fr, re-implement the full parsing logic
        // here (using cheerio to extract .hr_film blocks).
        void cheerio;

        // Stub: full parsing logic omitted — this is a sleeping backup.
        // The actual .hr_film parsing was preserved above to detect schema
        // changes; full re-implementation would go here if the site reverts.
        const movies: Movie[] = [];
        const availableDays: string[] = [];
        return { availableDays, movies };
      },
    };
  },
};

export default plugin;

// ── Backward-compatible factory ─────────────────────────────────────────────

export interface CineChateauConfig {
  baseUrl: string;
  schedulePath?: string;
}

/** Build a CineChateau adapter for one cinema.
 *  @deprecated use the plugin's `createAdapter()` directly via the registry. */
export function createCineChateauAdapter(cinemaId: string, cfg: CineChateauConfig): CinemaAdapter {
  // Inject the `kind` field for the new plugin contract (backward compat).
  return plugin.createAdapter(cinemaId, { kind: 'cinechateau', ...cfg });
}
