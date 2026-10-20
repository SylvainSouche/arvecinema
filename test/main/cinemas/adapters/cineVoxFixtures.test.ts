// ──────────────────────────────────────────────────────────────────────────
// cineVox FIXTURE suite — Pipeline A: the cheerio scraper against the REAL
// captured /horaires/ page (303 KB, record time), plus invalid-variant
// twins matching the monitoring states (challenge page, redesigned page,
// schema-change invariant CMB-016/BUG-02).
//
// browserFetch is mocked (it drives a real hidden Chromium via Electron —
// the thing under test here is the PARSER, not the browser transport).
// ──────────────────────────────────────────────────────────────────────────

import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const FIXTURES: Record<string, { status: number; body: string }> = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), 'test/fixtures/network-capture.json'), 'utf8'),
);
const horairesKey = Object.keys(FIXTURES).find(
  (k) => k.includes('cinemavox-chamonix.com/horaires'),
)!;
if (!horairesKey) throw new Error('cinevox /horaires/ capture missing from fixture');

let servedHtml = '';
vi.mock('../../../../src/main/ratings/browserFetch', () => ({
  browserFetch: vi.fn(async () => servedHtml),
}));

import { getPlugin } from '../../../../src/main/cinemas/adapters';
import { ScraperSchemaChangedError } from '../../../../src/main/cinemas/adapters/cineChateau';

function makeAdapter() {
  const plugin = getPlugin('cinevox');
  if (!plugin) throw new Error('cinevox plugin missing');
  return plugin.createAdapter('chamonix', {
    baseUrl: 'https://www.cinemavox-chamonix.com',
  });
}

beforeEach(() => {
  servedHtml = FIXTURES[horairesKey].body;
});

describe('cineVox adapter — real captured /horaires/ page (chamonix)', () => {
  it('parses the captured page into movies with real titles and timestamps', async () => {
    const schedule = await makeAdapter().fetchSchedule(14);

    expect(schedule.movies.length).toBeGreaterThan(0);
    // Titles are scraped (no "Film <n>" placeholder leakage on this source).
    expect(schedule.movies.every((m) => m.title.length > 0)).toBe(true);
    expect(schedule.movies.some((m) => /^Film \d+$/.test(m.title))).toBe(false);

    for (const m of schedule.movies) {
      expect(m.cinemaId).toBe('chamonix');
      // Showtimes sorted ascending per movie (adapter contract).
      const times = m.showtimes.map((s) => s.time);
      expect(times).toEqual([...times].sort());
      // Times come from booking-URL Unix timestamps → real ISO stamps.
      for (const st of m.showtimes) {
        expect(() => new Date(st.time).getTime()).not.toThrow();
        expect(Number.isNaN(new Date(st.time).getTime())).toBe(false);
      }
    }
  });

  it('availableDays are ISO days derived from the actual showtimes (sorted, unique)', async () => {
    const schedule = await makeAdapter().fetchSchedule(14);
    const fromShowtimes = new Set<string>();
    for (const m of schedule.movies) for (const st of m.showtimes) fromShowtimes.add(st.day);
    expect(schedule.availableDays).toEqual([...fromShowtimes].sort());
    expect(schedule.availableDays.length).toBeGreaterThan(0);
    expect(schedule.availableDays.every((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))).toBe(true);
  });

  it('version tags: the real programme carries both VF and VO prints', async () => {
    const schedule = await makeAdapter().fetchSchedule(14);
    expect(schedule.movies.some((m) => m.hasVF)).toBe(true);
    expect(schedule.movies.some((m) => m.hasVO)).toBe(true);
    // Ticketing links survive (booking URLs are the parser's timestamp source).
    expect(
      schedule.movies.some((m) => m.showtimes.some((s) => s.ticketingUrl?.includes('/reserver/'))),
    ).toBe(true);
  });
});

describe('cineVox adapter — invalid responses (monitoring-state twins)', () => {
  it('Cloudflare challenge shell → graceful empty schedule (browser path, not parser crash)', async () => {
    servedHtml =
      '<!DOCTYPE html><html><head><title>Just a moment...</title></head>' +
      '<body>Checking your browser before accessing www.cinemavox-chamonix.com.</body></html>';
    const schedule = await makeAdapter().fetchSchedule(14);
    expect(schedule.availableDays).toEqual([]);
    expect(schedule.movies).toEqual([]);
  });

  it('redesigned page without .hr_film blocks → graceful empty (silent schema drift)', async () => {
    servedHtml = '<html><body><div class="nouveau-design">Nos séances bientôt ici</div></body></html>';
    const schedule = await makeAdapter().fetchSchedule(14);
    expect(schedule.movies).toEqual([]);
  });

  it('day tabs present but ZERO parseable films → explicit ScraperSchemaChangedError (CMB-016/BUG-02)', async () => {
    servedHtml =
      '<html><body><div class="hr_film">' +
      '<div class="lesjours"><div class="fcel jour0"><span class="nom_jour">Lun.</span><a href="#">27</a></div></div>' +
      '</div></body></html>';
    await expect(makeAdapter().fetchSchedule(14)).rejects.toThrow(ScraperSchemaChangedError);
  });
});
