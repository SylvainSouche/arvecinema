#!/usr/bin/env node
// ──────────────────────────────────────────────────────────────────────────
// scrape-probe — HTTP reachability check of every scraping protocol the app
// depends on, run from CI. Answers one question directly: do the cinema
// sites / rating sources block GitHub-runner IPs?
//
// Scope (mirrors src/main/ — the exact endpoints the adapters use):
//   - 4 builtin cinemas, via their REAL schedule endpoints
//     (boxofficeapi: {baseUrl}/api/gatsby-source-boxofficeapi/schedule?…;
//      cinevox: site root — playwright scrapes HTML)
//   - rating sources: Wikidata API, AlloCiné search page, Rotten Tomatoes,
//     IMDB title page (browser-only: the app reaches it via browserFetch +
//     AWS WAF challenge — a plain fetch 403 there is a WARN, not a block
//     verdict), IMDB datasets host
//
// Interpretation guide:
//   ok      — 2xx/3xx: reachable, no block
//   warn    — browser-only sources (IMDB WAF) where a plain-fetch
//             403/429/503 is expected, reached later via browserFetch
//   blocked — everything else non-2xx: hard block (403/429/503 on
//             plain-HTTP sources → IP/UA problem) OR endpoint moved/
//             removed (404/410/… → scraping protocol regression)
//   error   — network failure / timeout / DNS
//
// Drift risk (documented): the endpoints here mirror the adapters by hand.
// test/main/scrapeProbeContract.test.ts pins the mirroring (UA format,
// endpoint shapes) — update both together when an adapter changes.
//
// Usage:
//   node scripts/scrape-probe.mjs                 # human table, exit 1 on blocked/error
//   node scripts/scrape-probe.mjs --json out.json # + JSON artifact
//   PROBE_TIMEOUT_MS=15000 node scripts/scrape-probe.mjs
//
// Module use (vitest): buildProbeTargets() + runProbe() are exported and
// unit-tested with an injected fetch — no network in tests.
// ──────────────────────────────────────────────────────────────────────────

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Same format as src/shared/userAgent.ts (Wikimedia UA policy requires a
 *  contact URL; a bare AppName/version gets 403-blocked). */
export function buildUserAgent(version) {
  return `ArveCinema/${version} (https://github.com/SylvainSouche/arvecinema)`;
}

/**
 * Build the probe list from the builtin cinema config (JSON shape of
 * src/main/cinemas/cinemas.config.json).
 * @param {Array<{id: string, adapter: {kind: string, baseUrl: string, theaterId?: string}}>} cinemas
 */
export function buildProbeTargets(cinemas) {
  const now = new Date();
  const from = new Date(now);
  from.setHours(3, 0, 0, 0);
  const to = new Date(now);
  to.setDate(to.getDate() + 14);
  to.setHours(3, 0, 0, 0);
  const timeZone = 'Europe/Paris';

  const targets = [];
  for (const c of cinemas) {
    const { kind, baseUrl, theaterId } = c.adapter;
    if (kind === 'boxofficeapi') {
      const params = new URLSearchParams({
        from: from.toISOString(),
        to: to.toISOString(),
        theaters: JSON.stringify({ id: theaterId, timeZone }),
      });
      targets.push({
        id: `cinema:${c.id}`,
        group: 'cinemas',
        url: `${baseUrl}/api/gatsby-source-boxofficeapi/schedule?${params}`,
        headers: { Referer: `${baseUrl}/` },
        expect: 'ok',
      });
    } else {
      // Scraper-kind (e.g. cinevox): the schedule API is the HTML page the
      // playwright scraper walks — reachability of the root is the check.
      targets.push({
        id: `cinema:${c.id}`,
        group: 'cinemas',
        url: baseUrl,
        headers: {},
        expect: 'ok',
      });
    }
  }

  targets.push(
    {
      id: 'ratings:wikidata',
      group: 'ratings',
      // Same API the app uses (NO SPARQL endpoint — see wikidataClient.ts).
      url: 'https://www.wikidata.org/w/api.php?action=wbgetentities&ids=Q42&format=json',
      headers: {},
      expect: 'ok',
    },
    {
      id: 'ratings:allocine',
      group: 'ratings',
      url: 'https://www.allocine.fr/recherche/?q=cinema',
      headers: {},
      expect: 'ok',
    },
    {
      id: 'ratings:rottentomatoes',
      group: 'ratings',
      url: 'https://www.rottentomatoes.com/',
      headers: {},
      expect: 'ok',
    },
    {
      id: 'ratings:imdb-title',
      group: 'ratings',
      // Fronted by AWS WAF; the app goes through a real browser window
      // (browserFetch). A plain-fetch 403 here is WARN, not a block verdict.
      url: 'https://www.imdb.com/title/tt0111161/',
      headers: {},
      expect: 'browser-ok',
    },
    {
      id: 'ratings:imdb-datasets',
      group: 'ratings',
      url: 'https://datasets.imdbws.com/title.ratings.tsv.gz',
      method: 'HEAD',
      headers: {},
      expect: 'ok',
    },
  );
  return targets;
}

/**
 * Run the probe. `fetchImpl` is injected so tests never touch the network.
 * @returns {Promise<{ok: boolean, results: Array<Record<string, unknown>>}>}
 */export async function runProbe(targets, deps) {
  const { fetchImpl, timeoutMs, userAgent } = deps;
  const results = [];
  for (const t of targets) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const started = Date.now();
    let status = null;
    let verdict;
    let detail = '';
    try {
      const res = await fetchImpl(t.url, {
        method: t.method ?? 'GET',
        headers: { 'User-Agent': userAgent, Accept: '*/*', ...t.headers },
        signal: controller.signal,
        redirect: 'follow',
      });
      status = res.status;
      if (res.status >= 200 && res.status < 400) {
        verdict = 'ok';
      } else if ([403, 429, 503].includes(res.status)) {
        verdict = t.expect === 'browser-ok' ? 'warn' : 'blocked';
        detail =
          t.expect === 'browser-ok'
            ? `HTTP ${res.status} — expected for plain fetch (browser-only source)`
            : `HTTP ${res.status} — plain-HTTP source rejecting us (IP/UA block?)`;
      } else {
        // 404/410 etc. — the endpoint MOVED or was REMOVED: a scraping
        // protocol regression (the app keeps calling it and gets garbage).
        verdict = 'blocked';
        detail = `HTTP ${res.status} — endpoint moved/removed? scraping protocol regression`;
      }
    } catch (err) {
      const isAbort =
        err instanceof Error &&
        (err.name === 'AbortError' || /aborted|timeout/i.test(err.message ?? ''));
      verdict = 'error';
      detail = isAbort ? `timeout after ${timeoutMs}ms` : `${err?.message ?? String(err)}`;
    } finally {
      clearTimeout(timer);
    }
    results.push({
      id: t.id,
      group: t.group,
      url: t.url,
      method: t.method ?? 'GET',
      status,
      ms: Date.now() - started,
      verdict,
      detail,
    });
  }
  const ok = results.every((r) => r.verdict === 'ok' || r.verdict === 'warn');
  return { ok, results };
}

function printTable(results) {
  const pad = (s, n) => String(s).padEnd(n);
  console.log('');
  console.log(pad('TARGET', 26) + pad('STATUS', 8) + pad('MS', 8) + pad('VERDICT', 9) + 'DETAIL');
  console.log('─'.repeat(96));
  for (const r of results) {
    console.log(
      pad(r.id, 26) +
        pad(r.status ?? '—', 8) +
        pad(r.ms, 8) +
        pad(r.verdict.toUpperCase(), 9) +
        r.detail,
    );
  }
  console.log('─'.repeat(96));
}

async function main() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const pkg = JSON.parse(fs.readFileSync(path.join(here, '../package.json'), 'utf8'));
  const config = JSON.parse(
    fs.readFileSync(path.join(here, '../src/main/cinemas/cinemas.config.json'), 'utf8'),
  );
  const timeoutMs = Number(process.env.PROBE_TIMEOUT_MS ?? 15000);
  const targets = buildProbeTargets(config.cinemas);
  const { ok, results } = await runProbe(targets, {
    fetchImpl: fetch,
    timeoutMs,
    userAgent: buildUserAgent(pkg.version),
  });
  printTable(results);

  const jsonArg = process.argv.indexOf('--json');
  const outPath = jsonArg >= 0 ? process.argv[jsonArg + 1] : process.env.PROBE_OUTPUT;
  if (outPath) {
    fs.writeFileSync(outPath, JSON.stringify({ ok, results }, null, 2) + '\n');
    console.log(`[scrape-probe] report written: ${outPath}`);
  }

  const blocked = results.filter((r) => r.verdict !== 'ok' && r.verdict !== 'warn');
  console.log(
    `[scrape-probe] ${ok ? 'ALL REACHABLE' : 'FAILURES'}: ${results.length - blocked.length} ok/warn, ${blocked.length} blocked/error`,
  );
  process.exit(ok ? 0 : 1);
}

// Run as CLI only when executed directly (vitest imports it as a module).
const isCli = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isCli) await main();
