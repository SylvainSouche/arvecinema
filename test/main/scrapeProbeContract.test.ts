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
import { buildUserAgent, buildProbeTargets, runProbe } from '../../scripts/scrape-probe.mjs';

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
      'ratings:allocine',
      'ratings:rottentomatoes',
      'ratings:imdb-title',
      'ratings:imdb-datasets',
    ]);
    // Wikidata via api.php only — the app deliberately does NOT use SPARQL.
    expect(probeSource).toContain('api.php');
    expect(probeSource).not.toContain('query.wikidata.org');
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
