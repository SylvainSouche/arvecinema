// ──────────────────────────────────────────────────────────────────────────
// scrapeProbeContract tests — scrape-probe.mjs mirrors the app's scraping
// protocols BY HAND (scripts/scrape-probe.mjs). When an adapter changes
// its endpoint shape or the User-Agent policy changes, the probe must be
// updated with it — these tests pin that mirroring and the probe's
// verdict logic (with an injected fetch: no network in unit tests).
//
// The scheduled CI job (.github/workflows/nonregression.yml — weekly + a
// dispatchable dry run) executes the probe for real against the live
// network; that part can't be unit-tested.
// ──────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { buildUserAgent, buildProbeTargets, runProbe, validateBoxofficeSchedule, validateHtmlReachable, validateAllocineFichefilm } from '../../scripts/scrape-probe.mjs';

const probeSource = readFileSync(
  path.join(process.cwd(), 'scripts/scrape-probe.mjs'),
  'utf8',
);
const config = JSON.parse(
  readFileSync(path.join(process.cwd(), 'src/main/cinemas/cinemas.config.json'), 'utf8'),
);

describe('scrape-probe: covers every builtin cinema', () => {
  it('one probe target per configured cinema', () => {
    const ids = buildProbeTargets(config.cinemas)
      .filter((t) => t.group === 'cinemas')
      .map((t) => t.id);
    const expected = config.cinemas.map((c: { id: string }) => `cinema:${c.id}`);
    expect(ids.sort()).toEqual([...expected].sort());
  });

  it('boxofficeapi cinemas probe their real schedule endpoint (adapter shape)', () => {
    // Note: buildProbeTargets always appends the 5 rating-source targets —
    // filter to the cinema group for this mirror check.
    const targets = buildProbeTargets(
      config.cinemas.filter((c: { adapter: { kind: string } }) => c.adapter.kind === 'boxofficeapi'),
    ).filter((t) => t.group === 'cinemas');
    for (const t of targets) {
      expect(t.url).toMatch(/\/api\/gatsby-source-boxofficeapi\/schedule\?/);
      const params = new URL(t.url).searchParams;
      const theaters = JSON.parse(params.get('theaters') ?? '{}');
      expect(theaters.id).toBeTruthy();
      expect(theaters.timeZone).toBe('Europe/Paris'); // same window contract as the adapter
      expect(params.get('from')).toBeTruthy();
      expect(params.get('to')).toBeTruthy();
    }
  });
});

describe('scrape-probe: UA + rating sources mirror the app', () => {
  it('UA format matches src/shared/userAgent.ts (Wikimedia policy: contact URL required)', () => {
    expect(buildUserAgent('9.9.9')).toBe(
      'ArveCinema/9.9.9 (https://github.com/SylvainSouche/arvecinema)',
    );
    // The shared module is the source of truth — same contact URL at both sites.
    const shared = readFileSync(path.join(process.cwd(), 'src/shared/userAgent.ts'), 'utf8');
    const contact = shared.match(/github\.com\/[^)`]+/)?.[0];
    expect(contact).toBeTruthy();
    expect(probeSource).toContain(contact);
  });

  it('the rating sources probed are the ones the app actually fetches', () => {
    const ids = buildProbeTargets([]).map((t) => t.id);
    expect(ids).toEqual([
      'ratings:wikidata',
      'ratings:allocine-search',
      'ratings:allocine-fichefilm',
      'ratings:rottentomatoes',
      'ratings:imdb-title',
      'ratings:imdb-datasets',
    ]);
    // Wikidata via api.php only — the app deliberately does NOT use SPARQL.
    expect(probeSource).toContain('api.php');
    expect(probeSource).not.toContain('query.wikidata.org');
    // AlloCiné probe tracks the app's LIVE protocol endpoint…
    expect(probeSource).toContain('/recherche/?q=');
    // …and the ratings endpoint is pinned by its invariant (rating widget),
    // because a 200-but-widget-less page is how the cache got poisoned.
    expect(probeSource).toContain('fichefilm_gen_cfilm=');
    expect(probeSource).toContain('stareval');
  });

  it('fetchable JSON/HTML targets have invariant validators (no 200-but-useless passes)', () => {
    const targets = buildProbeTargets(config.cinemas);
    const validating = targets.filter((t) => t.parseBody).map((t) => t.id);
    // schedule endpoints (mirrors boxOfficeApi.ts Phase 1) + wikidata + RT root
    expect(validating).toContain('cinema:mont-blanc');
    expect(validating).toContain('cinema:bonneville');
    expect(validating).toContain('cinema:chamonix');
    expect(validating).toContain('ratings:wikidata');
    expect(validating).toContain('ratings:rottentomatoes');
    expect(validating).toContain('ratings:allocine-fichefilm');
    expect(targets.find((t) => t.id === 'ratings:imdb-title')?.parseBody).toBeFalsy();
    expect(targets.find((t) => t.id === 'ratings:imdb-datasets')?.parseBody).toBeFalsy();
  });
});

describe('scrape-probe: schedule invariant validator (real fixture body)', () => {
  const fixture: Record<string, { body: string }> = JSON.parse(
    readFileSync(path.join(process.cwd(), 'test/fixtures/network-capture.json'), 'utf8'),
  );
  const schedKey = Object.keys(fixture).find(
    (k) => k.includes('schedule') && k.includes('P1798'),
  );
  expect(schedKey).toBeDefined();
  const realBody = fixture[schedKey as string].body;

  it('HEALTHY: the real captured mont-blanc schedule validates with stats', () => {
    expect(realBody).toBeTruthy();
    const v = validateBoxofficeSchedule(realBody, 'P1798');
    expect(v.state).toBe('healthy');
    if (!v.stats) throw new Error('expected stats on a healthy schedule');
    expect(v.stats.movies).toBeGreaterThan(0);
    expect(v.stats.showtimes).toBeGreaterThan(0);
    expect(v.stats.days).toBeGreaterThan(0);
    expect(v.stats.malformed).toBe(0);
  });

  it('BROKEN: missing theater key / missing .schedule / non-JSON body', () => {
    const theater = JSON.parse(realBody);
    delete theater.P1798;
    expect(validateBoxofficeSchedule(JSON.stringify(theater), 'P1798').state).toBe('broken');
    const noSchedule = { P1798: {} };
    expect(validateBoxofficeSchedule(JSON.stringify(noSchedule), 'P1798').state).toBe('broken');
    expect(validateBoxofficeSchedule('<html>Now JSON</html>', 'P1798').state).toBe('broken');
  });

  it('UNKNOWN: valid shape but empty schedule (off-season) is NOT a failure', () => {
    const empty = JSON.parse(realBody);
    empty.P1798.schedule = {};
    const v = validateBoxofficeSchedule(JSON.stringify(empty), 'P1798');
    expect(v.state).toBe('unknown');
    // unknown never fails the whole probe
    expect(v.stats?.movies).toBe(0);
  });

  it('DEGRADED: showtimesDates missing (day selector breaks) + malformed startsAt rows', () => {
    const noDates = JSON.parse(realBody);
    delete noDates.P1798.showtimesDates;
    expect(validateBoxofficeSchedule(JSON.stringify(noDates), 'P1798').state).toBe('degraded');

    const theater: Record<
      string,
      { schedule: Record<string, Record<string, Array<Record<string, unknown>>>> }
    > = JSON.parse(realBody);
    const firstMovieKey = Object.keys(theater.P1798.schedule)[0];
    const firstDayKey = Object.keys(theater.P1798.schedule[firstMovieKey])[0];
    theater.P1798.schedule[firstMovieKey][firstDayKey][0].startsAt = 'not-a-date';
    const v = validateBoxofficeSchedule(JSON.stringify(theater), 'P1798');
    expect(v.state).toBe('degraded');
    expect(v.stats?.malformed).toBe(1);
  });
});

describe('scrape-probe: challenge-page detection (HTML sources)', () => {
  it('200-but-Cloudflare → degraded (reachable, useless to the scraper)', () => {
    expect(validateHtmlReachable('<html>Just a moment...</html>', 'x').state).toBe('degraded');
    expect(validateHtmlReachable('<form id="cf-challenge">', 'x').state).toBe('degraded');
    expect(validateHtmlReachable('<html><body>les séances</body></html>', 'x').state).toBe('healthy');
  });

  it('benign recaptcha integrations (booking widgets) are NOT challenges', () => {
    // Real case: cinevox /horaires/ embeds a recaptcha release script on ~4.
    const page = '<html><body><h1>Séances</h1>' + '<p>séance</p>'.repeat(2000) +
      '<script src="https://www.gstatic.com/recaptcha/releases/x/recaptcha__fr.js" async></script></body></html>';
    expect(validateHtmlReachable(page, 'x').state).toBe('healthy');
  });
});

describe('scrape-probe: allocine fichefilm validator (rating-widget invariant)', () => {
  const filmPage = (extra = '') =>
    `<html><head><meta property="og:title" content="X"/><script type="application/ld+json">{"@type":"Movie"}</script></head><body>${extra}${'<p>synopsis</p>'.repeat(200)}</body></html>`;

  it('HEALTHY: film page with the stareval rating widget', () => {
    const v = validateAllocineFichefilm(filmPage('<div class="stareval-stars"></div>'));
    expect(v.state).toBe('healthy');
    expect(v.detail).toContain('rating widget present');
  });

  it('DEGRADED: 200 film page WITHOUT the rating widget (bot-mitigation variant, 2026-10-28 failure)', () => {
    const v = validateAllocineFichefilm(filmPage());
    expect(v.state).toBe('degraded');
    expect(v.detail).toContain('rating widget');
  });

  it('DEGRADED: the embedded CSS mention of stareval is not the widget', () => {
    // cfilm=323550's stripped page contains exactly one 'stareval' — the
    // .stareval-note CSS definition — and must still be degraded.
    const v = validateAllocineFichefilm(
      filmPage().replace('</head>', '<style>.entity-card .stareval-note{font-size:1rem}</style></head>'),
    );
    expect(v.state).toBe('degraded');
  });

  it('DEGRADED: challenge shell wins over shape checks', () => {
    const v = validateAllocineFichefilm(filmPage('<div class="stareval-stars"></div>').replace('<head>', '<head>Just a moment...'));
    expect(v.state).toBe('degraded');
  });

  it('BROKEN: not a fichefilm page (no og:title, no ld+json Movie)', () => {
    const v = validateAllocineFichefilm('<html><body>' + '<p>menu</p>'.repeat(200) + '</body></html>');
    expect(v.state).toBe('broken');
  });

  it('BROKEN: empty/too-small body', () => {
    expect(validateAllocineFichefilm('').state).toBe('broken');
    expect(validateAllocineFichefilm('<html></html>').state).toBe('broken');
  });
});

describe('scrape-probe: verdict classification (injected fetch, no network)', () => {
  const base = {
    id: 'x',
    group: 'cinemas' as const,
    url: 'https://t/x',
    headers: {},
    expect: 'ok' as const,
  };

  const run = async (status: number | 'abort', expect: 'ok' | 'browser-ok' = 'ok') => {
    const fetchImpl =
      status === 'abort'
        ? async () => {
            const e = new Error('The operation was aborted');
            e.name = 'AbortError';
            throw e;
          }
        : async () => ({ status });
    const { ok, results } = await runProbe([{ ...base, expect }], {
      fetchImpl,
      timeoutMs: 1000,
      userAgent: 'test',
    } as never);
    return { ok, verdict: results[0].verdict };
  };

  it('2xx/3xx → ok', async () => {
    expect((await run(200)).verdict).toBe('ok');
    expect((await run(302)).verdict).toBe('ok');
    expect((await run(200)).ok).toBe(true);
  });

  it('403/429/503 → blocked on plain-HTTP sources, warn on browser-only (IMDB WAF)', async () => {
    expect((await run(403)).verdict).toBe('blocked');
    expect((await run(429)).ok).toBe(false);
    expect((await run(503)).verdict).toBe('blocked');
    expect((await run(403, 'browser-ok')).verdict).toBe('warn');
    expect((await run(403, 'browser-ok')).ok).toBe(true);
  });

  it('404/410 → blocked (endpoint moved/removed — protocol regression signal)', async () => {
    expect((await run(404)).verdict).toBe('blocked');
    expect((await run(410)).ok).toBe(false);
    expect((await run(400)).verdict).toBe('blocked');
  });

  it('timeout/DNS failure → error and overall failure', async () => {
    const res = await run('abort');
    expect(res.verdict).toBe('error');
    expect(res.ok).toBe(false);
  });
});
