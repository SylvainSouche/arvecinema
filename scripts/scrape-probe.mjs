#!/usr/bin/env node
// ──────────────────────────────────────────────────────────────────────────
// scrape-probe — non-regression of every scraping protocol the app depends
// on, run from CI. Two layers per target:
//
//   1. HTTP reachability (status code)
//   2. INVARIANT VALIDATION of the response body where the protocol is
//      plain fetch (JSON schedule APIs, HTML sources): does the payload
//      still carry what the adapters parse? This is what catches "the site
//      returns 200 but nothing the app can use" — the failure class the
//      recorded fixture CI is blind to.
//
// State model (per target; mirrors the "healthy → changed → degraded →
// broken → unknown" monitoring framework):
//   healthy  — reachable AND invariants pass (screenings present, fields sane)
//   degraded — reachable, parses, but a piece is off (missing showtimesDates,
//              malformed startsAt rows, challenge-page markers in HTML)
//   broken   — unreachable, wrong shape (no body[theaterId].schedule), or
//              endpoint removed/moved (404/410) — the app cannot work
//   unknown  — reachable and valid-shaped but EMPTY schedule: NOT a failure
//              by default (cinema may be between programmes). The weekly
//              issue-notifier tracks a sustained-empty streak separately.
//
// Endpoint scope (mirrors src/main/ — the exact endpoints adapters use):
//   - boxofficeapi cinemas (3/4): {baseUrl}/api/gatsby-source-boxofficeapi/
//     schedule?from=&to=&theaters= — same params as the adapter
//   - cinevox: {baseUrl}/horaires/ HTML the cheerio scraper walks (probe =
//     reachability + challenge-marker detection; deep parsing lives in the
//     adapter fixture tests and e2e-live)
//   - ratings: Wikidata api.php (entity + P1265 id registry), AlloCiné
//     fichefilm pages, RT, IMDB title page
//     (browser-only — plain-fetch challenge 403s are 'warn', not broken),
//     IMDB datasets host
//
// Drift risk (documented): validator fields mirror boxOfficeApi.ts Phase 1
// by hand. test/main/scrapeProbeContract.test.ts pins the mirroring —
// update both together when the adapter changes.
//
// Usage:
//   node scripts/scrape-probe.mjs                 # human table, exit 1 on broken/degraded
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

/** Challenge-page markers for HTML sources served "200 OK but it's a WAF".
 *  Deliberately UNAMBIGUOUS only: 'captcha'/'recaptcha' are excluded — real
 *  cinema pages embed benign reCAPTCHA scripts for booking forms (seen on
 *  cinevox /horaires/, a 300 KB page, first hit at char 1154). Actual
 *  challenge shells put "Just a moment..." / cf-challenge in the first KB. */
const CHALLENGE_MARKERS = ['just a moment', 'cf-challenge', 'aws-waf-token'];

/** Challenge shells are tiny; only scan the head of the document. */
const CHALLENGE_SCAN_BYTES = 8192;

/**
 * Invariant validator for a boxofficeapi schedule response — mirrors
 * boxOfficeApi.ts Phase 1 expectations (theaterData.schedule object keyed
 * by movie, showtimesDates array for the day selector, per-showtime
 * startsAt + tags; screen/data are adapter-optional).
 */
export function validateBoxofficeSchedule(bodyText, theaterId) {
  let stats;
  try {
    const raw = JSON.parse(bodyText);
    const theater = raw?.[theaterId];
    if (!theater || typeof theater !== 'object') {
      return { state: 'broken', detail: `no "${theaterId}" key in schedule JSON — adapter can't find its data` };
    }
    if (!theater.schedule || typeof theater.schedule !== 'object') {
      return { state: 'broken', detail: 'missing/invalid ".schedule" — the property the adapter iterates is gone' };
    }
    const movieIds = Object.keys(theater.schedule);
    let showtimes = 0;
    let malformed = 0;
    for (const dates of Object.values(theater.schedule)) {
      if (!dates || typeof dates !== 'object') continue;
      for (const dayList of Object.values(dates)) {
        if (!Array.isArray(dayList)) continue;
        for (const st of dayList) {
          showtimes++;
          const d = st?.startsAt ? new Date(st.startsAt) : null;
          if (!d || Number.isNaN(d.getTime())) malformed++;
        }
      }
    }
    const daysOk = Array.isArray(theater.showtimesDates);
    stats = {
      movies: movieIds.length,
      days: daysOk ? theater.showtimesDates.length : 0,
      showtimes,
      malformed,
    };

    if (movieIds.length === 0 || showtimes === 0) {
      return { state: 'unknown', detail: 'valid shape but EMPTY schedule (off-season empty is normal; streak tracked downstream)', stats };
    }
    if (!daysOk) {
      return { state: 'degraded', detail: '".showtimesDates" missing — day selector breaks while schedules still parse', stats };
    }
    if (malformed > 0) {
      return { state: 'degraded', detail: `${malformed}/${showtimes} showtimes with unparseable "startsAt"`, stats };
    }
    return { state: 'healthy', detail: `${movieIds.length} movies, ${theater.showtimesDates.length} days, ${showtimes} showtimes`, stats };
  } catch (err) {
    return { state: 'broken', detail: `schedule endpoint no longer JSON: ${err?.message ?? String(err)}` };
  }
}

/** AlloCiné fichefilm validator: the invariant the ratings scraper relies on
 *  is the rating WIDGET, not just reachability. A 200 page without it is how
 *  a bot-mitigation variant / markup change silently poisons the ratings
 *  cache with "absent" (observed 2026-10-28). The widget detector matches
 *  widget MARKUP (`class="stareval…"`), not the bare string — every page
 *  embeds the `.stareval-note` CSS definition, so a stripped page still
 *  contains the word once. */
export function validateAllocineFichefilm(bodyText) {
  if (!bodyText || bodyText.length < 200) {
    return { state: 'broken', detail: 'response too small to be a fichefilm page' };
  }
  const snippet = bodyText.slice(0, CHALLENGE_SCAN_BYTES).toLowerCase();
  const hit = CHALLENGE_MARKERS.find((m) => snippet.includes(m));
  if (hit) {
    return { state: 'degraded', detail: `200 OK but response is a challenge page (marker: "${hit}") — browser-only path` };
  }
  const looksLikeFilmPage =
    bodyText.includes('property="og:title"') || /"@type"\s*:\s*"Movie"/.test(bodyText);
  if (!looksLikeFilmPage) {
    return { state: 'broken', detail: 'no og:title / ld+json Movie — not a fichefilm page (redirect or interstitial?)' };
  }
  if (!/class="[^"]*stareval/.test(bodyText)) {
    return { state: 'degraded', detail: 'film page without rating widget — bot-mitigation variant or AlloCiné markup change (scraper would record "absent")' };
  }
  return { state: 'healthy', detail: `fichefilm reachable, rating widget present (${Math.round(bodyText.length / 1024)} KB)` };
}

/** HTML source validator: reachable-but-challenge detection. */
export function validateHtmlReachable(bodyText, label) {
  const snippet = bodyText.slice(0, CHALLENGE_SCAN_BYTES).toLowerCase();
  const hit = CHALLENGE_MARKERS.find((m) => snippet.includes(m));
  if (hit) {
    return { state: 'degraded', detail: `200 OK but response is a challenge page (marker: "${hit}") — browser-only path` };
  }
  return { state: 'healthy', detail: `${label} reachable, no challenge markers (${Math.round(bodyText.length / 1024)} KB)` };
}

/**
 * Build the probe list from the builtin cinema config (JSON shape of
 * src/main/cinemas/cinemas.config.json).
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
        validate: (bodyText) => validateBoxofficeSchedule(bodyText, theaterId),
        parseBody: true,
      });
    } else {
      // Scraper-kind (e.g. cinevox): probe the FULL schedule page the
      // cheerio scraper walks, not just the root.
      targets.push({
        id: `cinema:${c.id}`,
        group: 'cinemas',
        url: `${baseUrl}/horaires/`,
        headers: {},
        expect: 'ok',
        parseBody: true,
        validate: (bodyText) => validateHtmlReachable(bodyText, 'schedule page'),
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
      parseBody: true,
      validate: (bodyText) => {
        try {
          const j = JSON.parse(bodyText);
          if (!j?.entities?.Q42) {
            return { state: 'broken', detail: 'wbgetentities response missing entities.Q42 — API contract changed' };
          }
          return { state: 'healthy', detail: 'wbgetentities shape ok (entities.Q42 present)' };
        } catch {
          return { state: 'broken', detail: 'wikidata api.php no longer JSON' };
        }
      },
    },
    {
      id: 'ratings:allocine-id-registry',
      group: 'ratings',
      // 2026-10: AlloCiné retired its server-rendered search (HTTP 410) and
      // moved to a
      // JWT'd GraphQL API — plain-HTTP search scraping is impossible. The
      // app resolves AlloCiné codes through WIKIDATA's P1265 claim space
      // (haswbstatement query) and boxofficeapi schedules (ids ARE AlloCiné
      // codes); ratings still come from fichefilm pages (next target). This
      // target pins the P1265 registry: the canary film (7124 = Terminator
      // 2) must stay findable via the MediaWiki search API.
      url:
        'https://www.wikidata.org/w/api.php?action=query&list=search&srsearch=' +
        encodeURIComponent('haswbstatement:P1265=7124') +
        '&srnamespace=0&srlimit=5&format=json',
      headers: {},
      expect: 'ok',
      parseBody: true,
      validate: (bodyText) => {
        try {
          const j = JSON.parse(bodyText);
          const hits = j?.query?.search?.length ?? 0;
          if (hits === 0) {
            return { state: 'broken', detail: 'haswbstatement:P1265 lookup returned 0 hits — id registry unusable' };
          }
          return { state: 'healthy', detail: `P1265 id registry responds (${hits} hit/s on the canary film)` };
        } catch {
          return { state: 'broken', detail: 'wikidata list=search no longer JSON' };
        }
      },
    },
    {
      id: 'ratings:allocine-fichefilm',
      group: 'ratings',
      // The ratings endpoint (allocineClient.fetchAllocineRatings): a stable
      // catalog film that will always have press + audience ratings. The
      // invariant is the RATING WIDGET, not just reachability — a 200 page
      // with the widget stripped (bot-mitigation variant observed 2026-10-28)
      // is exactly the failure that silently poisoned the ratings cache.
      url: 'https://www.allocine.fr/film/fichefilm_gen_cfilm=2072.html',
      headers: {},
      expect: 'ok',
      parseBody: true,
      validate: (bodyText) => validateAllocineFichefilm(bodyText),
    },
    {
      id: 'ratings:rottentomatoes',
      group: 'ratings',
      url: 'https://www.rottentomatoes.com/',
      headers: {},
      expect: 'ok',
      parseBody: true,
      validate: (bodyText) => validateHtmlReachable(bodyText, 'RT root'),
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
 */
export async function runProbe(targets, deps) {
  const { fetchImpl, timeoutMs, userAgent } = deps;
  const results = [];
  for (const t of targets) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const started = Date.now();
    let status = null;
    let verdict;
    let state = null;
    let stats = undefined;
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
        // Body-level invariant validation (only where the protocol is plain
        // fetch AND the response carries parseable content).
        if (t.parseBody) {
          try {
            const bodyText = await res.text();
            const v = t.validate(bodyText);
            state = v.state;
            stats = v.stats;
            detail = v.detail;
          } catch (err) {
            state = 'broken';
            detail = `body read failed: ${err?.message ?? String(err)}`;
          }
        }
        if (!state) {
          state = 'healthy';
          if (!detail) {
            detail =
              t.expect === 'browser-ok'
                ? 'HTTP ok (browser-only source; the app reaches it via browserFetch)'
                : '';
          }
        }
      } else if ([403, 429, 503].includes(res.status)) {
        verdict = t.expect === 'browser-ok' ? 'warn' : 'blocked';
        state = verdict === 'warn' ? 'unknown' : 'broken';
        detail =
          t.expect === 'browser-ok'
            ? `HTTP ${res.status} — expected for plain fetch (browser-only source)`
            : `HTTP ${res.status} — plain-HTTP source rejecting us (IP/UA block?)`;
      } else {
        // 404/410 etc. — the endpoint MOVED or was REMOVED: a scraping
        // protocol regression (the app keeps calling it and gets garbage).
        verdict = 'blocked';
        state = 'broken';
        detail = `HTTP ${res.status} — endpoint moved/removed? scraping protocol regression`;
      }
    } catch (err) {
      const isAbort =
        err instanceof Error &&
        (err.name === 'AbortError' || /aborted|timeout/i.test(err.message ?? ''));
      verdict = 'error';
      state = 'broken';
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
      state,
      stats,
      detail,
    });
  }
  const ok = results.every((r) => r.state !== 'broken' && r.state !== 'degraded');
  return { ok, results };
}

function printTable(results) {
  const pad = (s, n) => String(s).padEnd(n);
  console.log('');
  console.log(
    pad('TARGET', 26) + pad('STATUS', 8) + pad('MS', 8) + pad('STATE', 9) + 'DETAIL',
  );
  console.log('─'.repeat(100));
  for (const r of results) {
    const stat = r.stats
      ? ` [m${r.stats.movies}/d${r.stats.days}/s${r.stats.showtimes}${r.stats.malformed ? ` !${r.stats.malformed}` : ''}]`
      : '';
    console.log(pad(r.id, 26) + pad(r.status ?? '—', 8) + pad(r.ms, 8) + pad(r.state ?? '?', 9) + r.detail + stat);
  }
  console.log('─'.repeat(100));
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
    fs.writeFileSync(
      outPath,
      JSON.stringify(
        {
          ok,
          runAt: new Date().toISOString(),
          results,
        },
        null,
        2,
      ) + '\n',
    );
    console.log(`[scrape-probe] report written: ${outPath}`);
  }

  const bad = results.filter((r) => r.state === 'broken' || r.state === 'degraded');
  const unknown = results.filter((r) => r.state === 'unknown');
  console.log(
    `[scrape-probe] ${ok ? 'NO REGRESSIONS' : 'FAILURES'}: ` +
      `${results.length - bad.length - unknown.length} healthy, ${unknown.length} unknown(empty), ` +
      `${bad.filter((b) => b.state === 'degraded').length} degraded, ${bad.filter((b) => b.state === 'broken').length} broken`,
  );
  process.exit(ok ? 0 : 1);
}

// Run as CLI only when executed directly (vitest imports it as a module).
const isCli = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isCli) await main();
