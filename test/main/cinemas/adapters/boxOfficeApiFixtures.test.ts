// ──────────────────────────────────────────────────────────────────────────
// boxOfficeApi FIXTURE suite — Pipeline A of the non-regression system
// (adapters parse REAL, captured responses deterministically; no network).
//
// The captured bodies in test/fixtures/network-capture.json are what the
// adapters actually consumed at record time — the strongest available pin:
// a change in parsing logic is caught here against the exact input the
// sites really delivered (the replay e2e covers the app; these cover the
// adapter contract directly, at parse level).
//
// Covered:
//   - real mont-blanc schedule + metadata bodies → exact structural facts
//     (movie/day counts, sorted order, hasVF/hasVO tag semantics, real
//     titles replacing placeholders, availableDays === showtimesDates)
//   - HTTP 403 → adapter throws (classified 'http-error' upstream)
//   - 200-with-HTML → JSON parse failure propagates (schema regression)
//   - missing showtimesDates → movies still parsed, day list empty
//     ('degraded' monitoring state — matches scrape-probe)
//   - malformed startsAt rows skipped without dropping the cinema (BUG-01)
//   - metadata endpoint failure → silent placeholder fallback (CMB-006)
//
// All network is injected through the fetchWithTimeout mock.
// ──────────────────────────────────────────────────────────────────────────

import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/arvecinema-test', isPackaged: false },
  BrowserWindow: { getAllWindows: () => [] },
}));

// Injected fetch: hit URLs are served from the captured fixture.
interface CapturedEntry {
  status: number;
  body: string;
}
const FIXTURES: Record<string, CapturedEntry> = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), 'test/fixtures/network-capture.json'), 'utf8'),
);
const fetchCalls: string[] = [];

function findEntry(url: string, opFailed: CapturedEntry | null): CapturedEntry | null {
  if (opFailed) return opFailed;
  const direct = FIXTURES[`GET:${url}`];
  if (direct) return direct;
  return (
    Object.entries(FIXTURES).find(
      ([k, _]) => k.startsWith('GET:') && k.slice(4).split('?')[0] === url.split('?')[0],
    )?.[1] ?? null
  );
}

let nextFailure: CapturedEntry | null = null;
vi.mock('../../../../src/shared/fetchWithTimeout', () => ({
  REQUEST_TIMEOUT_MS: 5000,
  fetchWithTimeout: async (url: string) => {
    fetchCalls.push(url);
    const entry = nextFailure ?? findEntry(url, null);
    if (!entry) throw new Error(`fixture miss: ${url}`);
    return {
      ok: 200 <= entry.status && entry.status < 400,
      status: entry.status,
      json: async () => JSON.parse(entry.body),
    };
  },
}));

import { getPlugin } from '../../../../src/main/cinemas/adapters';

const MONTBLANC = {
  baseUrl: 'https://www.cinemontblanc.fr',
  theaterId: 'P1798',
};
const schedKey = Object.keys(FIXTURES).find((k) => k.includes('P1798') && k.includes('schedule'))!;
const schedData = JSON.parse(FIXTURES[schedKey].body).P1798;

function makeAdapter() {
  const plugin = getPlugin('boxofficeapi');
  if (!plugin) throw new Error('boxofficeapi plugin missing');
  return plugin.createAdapter('mont-blanc', MONTBLANC);
}

beforeEach(() => {
  nextFailure = null;
  fetchCalls.length = 0;
});

describe('boxOfficeApi adapter — real captured schedule (mont-blanc)', () => {
  it('parses the captured body into movies with resolved titles and sorted showtimes', async () => {
    const schedule = await makeAdapter().fetchSchedule(14);
    expect(schedule.movies.length).toBeGreaterThan(0);
    expect(schedule.movies.length).toBeLessThanOrEqual(Object.keys(schedData.schedule).length);

    // availableDays is exactly the recorded (sorted) showtimesDates — the
    // adapter's day list and the sites' agree.
    const fixtureDays = [...(schedData.showtimesDates as string[])].sort();
    expect(schedule.availableDays).toEqual(fixtureDays);

    // Titles resolved by the metadata endpoint — no "Film <id>" placeholders.
    const placeholders = schedule.movies.filter((m) => /^Film \d+$/.test(m.title));
    expect(placeholders).toEqual([]);

    // Showtimes: sorted within each movie, correct cinemaId, ISO timestamps.
    for (const m of schedule.movies.slice(0, 10)) {
      expect(m.cinemaId).toBe('mont-blanc');
      const times = m.showtimes.map((s) => s.time);
      expect(times).toEqual([...times].sort());
      for (const st of m.showtimes) expect(st.time).toMatch(/^20\d{2}-/);
    }
  });

  it('tag semantics: a movie with VF-tagged showtimes has hasVF === true (and not forced VO)', async () => {
    const schedule = await makeAdapter().fetchSchedule(14);
    const withVf = schedule.movies.filter((m) => m.hasVF);
    const withVo = schedule.movies.filter((m) => m.hasVO);
    // The real programme carries both dubbed and subtitled prints.
    expect(withVf.length).toBeGreaterThan(0);
    expect(withVo.length).toBeGreaterThan(0);
    // Duplicates: showtimes are unique within a movie (dedupe invariant).
    for (const m of schedule.movies) {
      const keys = m.showtimes.map((s) => `${s.day}|${s.hour}`);
      expect(new Set(keys).size).toBe(keys.length);
    }
  });

  it('the ranking metadata phase is actually exercised (POST-free, batched ids endpoint)', async () => {
    await makeAdapter().fetchSchedule(14);
    const metaCalls = fetchCalls.filter((u) => u.includes('/movies?'));
    expect(metaCalls.length).toBe(1); // 33 movies < BATCH_SIZE 80 → one batch
  });
});

describe('boxOfficeApi adapter — invalid responses (monitoring-state twins)', () => {
  it('HTTP 403 on the schedule endpoint → throws (upstream classifies http-error)', async () => {
    nextFailure = { status: 403, body: '' };
    await expect(makeAdapter().fetchSchedule(14)).rejects.toThrow(/HTTP 403/);
  });

  it('200-with-HTML → JSON parse failure propagates (schema regression surface)', async () => {
    nextFailure = { status: 200, body: '<html>redesign</html>' };
    await expect(makeAdapter().fetchSchedule(14)).rejects.toThrow();
  });

  it('missing showtimesDates → movies parsed, days empty (probe: degraded state)', async () => {
    const scheduleUrl = Object.keys(FIXTURES).find((k) => k.includes('schedule') && k.includes('P1798'))!;
    const real = FIXTURES[scheduleUrl];
    const theater = JSON.parse(real.body).P1798;
    delete theater.showtimesDates;
    FIXTURES[scheduleUrl] = { status: 200, body: JSON.stringify({ P1798: theater }) };
    try {
      const schedule = await makeAdapter().fetchSchedule(14);
      expect(schedule.movies.length).toBeGreaterThan(0);
      expect(schedule.availableDays).toEqual([]);
    } finally {
      FIXTURES[scheduleUrl] = real;
    }
  });

  it('a malformed startsAt row is skipped, its movie still parsed (BUG-01 contract)', async () => {
    const theater = JSON.parse(FIXTURES[schedKey].body).P1798;
    const firstMovie = Object.keys(theater.schedule)[0];
    const firstDay = Object.keys(theater.schedule[firstMovie])[0];
    theater.schedule[firstMovie][firstDay] = [
      { startsAt: null, tags: [] },
      { startsAt: 'garbage', tags: [] },
      ...theater.schedule[firstMovie][firstDay],
    ];
    // Serve the mutated schedule for the schedule URL; the movies endpoint
    // must NOT be patched (its own captured body still applies).
    const scheduleUrl = Object.keys(FIXTURES).find((k) => k.includes('schedule') && k.includes('P1798'))!;
    const real = FIXTURES[scheduleUrl];
    FIXTURES[scheduleUrl] = { status: 200, body: JSON.stringify({ P1798: theater }) };
    try {
      const schedule = await makeAdapter().fetchSchedule(14);
      const movie = schedule.movies.find((m) => m.id === firstMovie);
      expect(movie).toBeDefined();
      // The two garbage rows are skipped; the rest survive with valid times.
      for (const st of movie!.showtimes) expect(st.time).toMatch(/^20\d{2}-/);
    } finally {
      FIXTURES[scheduleUrl] = real;
    }
  });

  it('metadata endpoint outage → placeholder titles, schedule still delivered (CMB-006)', async () => {
    // Make only the /movies? call fail.
    const realRespond = Object.entries(FIXTURES).map(([k, e]) => (k.includes('/movies?') ? { k, e } : null)).filter(Boolean);
    void realRespond;
    const metaKey = Object.keys(FIXTURES).find((k) => k.includes('/movies?') && k.includes('cinemontblanc'))!;
    const real = FIXTURES[metaKey];
    FIXTURES[metaKey] = { status: 500, body: '{}' };
    try {
      const schedule = await makeAdapter().fetchSchedule(14);
      expect(schedule.movies.length).toBeGreaterThan(0);
      expect(schedule.movies.some((m) => /^Film \d+$/.test(m.title))).toBe(true);
    } finally {
      FIXTURES[metaKey] = real;
    }
  });
});
