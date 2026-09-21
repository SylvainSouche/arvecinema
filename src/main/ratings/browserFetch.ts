import { BrowserWindow, session } from 'electron';
import { withNetworkTracking } from './networkActivity';
import { log } from './moduleLoggers';
import { isReplaying, isRecording, getReplayResponse, recordResponse } from './networkRecorder';

// ──────────────────────────────────────────────────────────────────────────
// browserFetch — fetch a URL using a hidden Electron BrowserWindow.
//
// Bypasses Cloudflare by loading the page in a real Chromium browser.
// Key anti-detection measures:
//   - sandbox: true (real browser sandbox)
//   - Real User-Agent from the session (not a custom UA that looks fake)
//   - Wait for navigation to settle (challenge → redirect → real page)
//
// POOL: windows are pooled per-domain. A hidden BrowserWindow created for
// allocine.fr is kept alive after the fetch and reused for the next call to
// allocine.fr. This eliminates the ~500ms Chromium-init overhead per call.
// The Cloudflare cf_clearance cookie persists in the session partition
// (per-domain), so pooled windows also skip the Cloudflare challenge on
// subsequent calls.
//
// When the pool is empty (first call to a domain, or after a crash), a new
// window is created. When a window crashes, it's destroyed and removed from
// the pool — the next call will create a fresh one.
// ──────────────────────────────────────────────────────────────────────────

const DEBUG = process.env.ARVE_DEBUG === '1';
const NAVIGATION_TIMEOUT_MS = 20_000;

/** Format a timestamp for debug logs: HH:MM:ss.sss */
function ts(): string {
  const d = new Date();
  return (
    d.toLocaleTimeString('en-GB', { hour12: false }) +
    '.' +
    String(d.getMilliseconds()).padStart(3, '0')
  );
}

function extractDomain(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return 'default';
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Ad/tracker blocker — blocks parasitic requests at the network layer.
//
// When a hidden BrowserWindow loads an imdb.com or allocine.fr page, the
// page fires dozens of tracker requests (Amazon ads, DoubleClick, Facebook
// pixel, Google Analytics, ScorecardResearch, etc.). These are useless to
// us — we only want the page's own HTML — and they:
//   1. Slow down the page load (each tracker adds ~50-200ms)
//   2. Pollute the debug logs with `will-redirect blocked` noise
//   3. Generate unnecessary traffic to third-party domains
//   4. Reveal our scraping activity to ad networks
//
// We block them via `webRequest.onBeforeRequest` — the request never leaves
// the process, no network round-trip, no log noise.
// ──────────────────────────────────────────────────────────────────────────

/** Domains (or domain suffixes) to block at the network layer. */
const BLOCKED_DOMAIN_PATTERNS = [
  // Amazon ads (IMDB fires many of these per page load)
  'aax-eu.amazon-adsystem.com',
  'aax.amazon-adsystem.com',
  'amazon-adsystem.com',
  'amzn.to',
  // Google ads / analytics
  'doubleclick.net',
  'googlesyndication.com',
  'googleadservices.com',
  'google-analytics.com',
  'googletagmanager.com',
  'adservice.google.com',
  // Social trackers
  'connect.facebook.net',
  'connect.facebook.com',
  'pixel.facebook.com',
  'analytics.twitter.com',
  'static.ads-twitter.com',
  // Other ad / measurement
  'scorecardresearch.com',
  'c.scorecardresearch.com',
  'quantserve.com',
  'pixel.quantserve.com',
  'ad.doubleclick.net',
  's.amazon-adsystem.com',
  'fls-na.amazon.com',
  'completion.amazon.com',
  // IMDB-specific telemetry that's useless to us
  'fls-eu.amazon.com',
  'unagi.amazon.com',
  'unagi-na.amazon.com',
  'uedata.amazon.com',
  'analytics.imdb.com',
  // AlloCiné trackers
  'estat.allocine.fr',
  'cdn.tagcommander.com',
  'wmcdp.allocine.fr',
];

/** Returns true if a URL should be blocked at the network layer. */
function shouldBlockUrl(url: string): boolean {
  try {
    const hostname = new URL(url).hostname;
    return BLOCKED_DOMAIN_PATTERNS.some((d) => hostname === d || hostname.endsWith('.' + d));
  } catch {
    return false;
  }
}

/** Install the ad-blocker on a session. Called once per session (sessions
 *  are per-domain and persistent — the blocker lives for the app's lifetime). */
function installAdBlocker(ses: Electron.Session): void {
  ses.webRequest.onBeforeRequest((details, callback) => {
    if (shouldBlockUrl(details.url)) {
      if (DEBUG && Math.random() < 0.05) {
        log.browserFetch.info(
          `[${ts()}] [browserFetch] blocked tracker: ${details.url.substring(0, 80)}...`,
        );
      }
      callback({ cancel: true });
    } else {
      callback({});
    }
  });
}

// ── Per-domain session setup (once per session lifetime) ───────────────────

/** Tracks which session partitions have already been configured
 *  (ad-blocker + permission handlers). Sessions are per-domain and persist
 *  for the app's lifetime, so we only set up each one once. */
const configuredPartitions = new Set<string>();

function ensureSessionSetup(partition: string, ses: Electron.Session): void {
  if (configuredPartitions.has(partition)) return;
  configuredPartitions.add(partition);
  installAdBlocker(ses);
  ses.setPermissionRequestHandler(() => false);
  ses.setPermissionCheckHandler(() => false);
  if (DEBUG)
    log.browserFetch.info(`[${ts()}] [browserFetch] session setup for partition "${partition}"`);
}

// ──────────────────────────────────────────────────────────────────────────
// BrowserWindow pool — one idle window per domain.
//
// When browserFetch() is called:
//   1. Check if there's an idle window for this domain.
//   2. If yes → reuse it (skip ~500ms Chromium-init cost).
//   3. If no → create a new window.
//   4. After the fetch completes, return the window to the pool.
//   5. If the window crashed or is in a bad state, destroy it instead.
//
// Pool size: 1 per domain. If a second concurrent call arrives while the
// pooled window is busy, a TEMPORARY window is created and destroyed after
// use (same behavior as before pooling). This keeps the pool simple — no
// queueing, no deadlocks.
//
// The connection pool's per-domain delay (2s) already serializes most
// calls to the same domain, so 1 pooled window handles the common case.
// ──────────────────────────────────────────────────────────────────────────

/** Idle windows indexed by domain. At most 1 entry per domain. */
const idleWindows = new Map<string, BrowserWindow>();

/** Check if a window is healthy enough to reuse. */
function isHealthy(win: BrowserWindow): boolean {
  return !win.isDestroyed() && !win.webContents.isDestroyed();
}

/** Acquire a BrowserWindow for a domain. Reuses from pool if available,
 *  otherwise creates a new one. The caller MUST call releaseWindow() when done. */
function acquireWindow(domain: string, partition: string): BrowserWindow {
  const idle = idleWindows.get(domain);
  if (idle && isHealthy(idle)) {
    idleWindows.delete(domain);
    if (DEBUG) log.browserFetch.info(`[${ts()}] [browserFetch] pool: reused window for ${domain}`);
    return idle;
  }
  // Remove stale entry if the idle window was unhealthy
  if (idle) {
    idleWindows.delete(domain);
    try {
      idle.destroy();
    } catch {
      /* already destroyed */
    }
  }
  // Create a new window
  return createPooledWindow(partition);
}

/** Return a window to the pool. If `crashed`, destroy instead of pooling. */
function releaseWindow(domain: string, win: BrowserWindow, crashed: boolean): void {
  if (crashed || !isHealthy(win)) {
    if (!win.isDestroyed()) {
      try {
        win.destroy();
      } catch {
        /* ignore */
      }
    }
    idleWindows.delete(domain);
    return;
  }
  // Return to pool — but only if there isn't already one for this domain
  // (concurrent calls might both try to release to the same domain).
  if (idleWindows.has(domain)) {
    try {
      win.destroy();
    } catch {
      /* ignore */
    }
    if (DEBUG)
      log.browserFetch.info(
        `[${ts()}] [browserFetch] pool: destroyed extra window for ${domain} (pool full)`,
      );
  } else {
    idleWindows.set(domain, win);
    if (DEBUG)
      log.browserFetch.info(`[${ts()}] [browserFetch] pool: returned window to pool for ${domain}`);
  }
}

/** Create a new hidden BrowserWindow configured for scraping. */
function createPooledWindow(partition: string): BrowserWindow {
  const ses = session.fromPartition(partition);
  ensureSessionSetup(partition, ses);

  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 800,
    webPreferences: {
      session: ses,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      // Disable images — Cloudflare's `cf_clearance` cookie is set by
      // JavaScript execution (challenge.js), NOT by image loading.
      // Disabling images:
      //   - Cuts page load time from ~2-5s to ~500ms (no poster/ad fetches)
      //   - Eliminates noisy `ffmpeg_common.cc: Unsupported pixel format` errors
      //   - Reduces bandwidth (each imdb/allocine page loads ~20-50 images)
      //   - Skips ad network image-based tracking pixels entirely
      images: false,
      javascript: true,
    },
  });

  // NOTE: we do NOT install per-window setWindowOpenHandler / will-navigate /
  // will-redirect handlers here. The global handler in main/index.ts
  // (app.on('web-contents-created', ...)) already covers ALL BrowserWindows,
  // including hidden ones. It uses `contents.getURL()` (the window's current
  // URL) as the reference for same-domain checks, which is exactly right for
  // pooled windows — it allows WAF/Cloudflare reloads within the same domain
  // while blocking cross-origin navigations.

  return win;
}

/** Destroy all pooled windows. Called from gracefulShutdown(). */
export function destroyBrowserFetchPool(): void {
  let destroyed = 0;
  for (const win of idleWindows.values()) {
    if (!win.isDestroyed()) {
      try {
        win.destroy();
      } catch {
        /* ignore */
      }
      destroyed++;
    }
  }
  idleWindows.clear();
  if (destroyed > 0) {
    log.browserFetch.info(
      `[browserFetch] pool: destroyed ${destroyed} pooled window(s) on shutdown`,
    );
  }
}

// ──────────────────────────────────────────────────────────────────────────
// browserFetch — public API
// ──────────────────────────────────────────────────────────────────────────

/** Fetch a URL via a hidden BrowserWindow. Returns the full page HTML.
 *  Wrapped in `withNetworkTracking` so the renderer's refresh-icon spinner
 *  knows when network activity is in flight. */
export async function browserFetch(
  url: string,
  _opts: { headers?: Record<string, string>; referer?: string } = {},
): Promise<string> {
  // ── Replay mode: return recorded HTML, no BrowserWindow needed ──
  if (isReplaying) {
    const recorded = getReplayResponse('GET', url);
    if (recorded) {
      return recorded.body;
    }
    // Fall through to real fetch if not in fixture
  }

  const result = withNetworkTracking(() => browserFetchImpl(url, _opts));

  // ── Record mode: save the HTML response ──
  if (isRecording) {
    const html = await result;
    recordResponse('GET', url, 200, html);
    return html;
  }

  return result;
}

async function browserFetchImpl(
  url: string,
  _opts: { headers?: Record<string, string>; referer?: string } = {},
): Promise<string> {
  // Use a persistent partition per-domain so Cloudflare cookies persist
  // between requests to the same site (Cloudflare sets a cf_clearance
  // cookie that lasts ~30 min — reusing it means subsequent requests
  // skip the challenge entirely).
  const domain = extractDomain(url);
  const partition = `browserfetch-${domain}`;

  const win = acquireWindow(domain, partition);
  let crashed = false;

  try {
    if (DEBUG) log.browserFetch.info(`[${ts()}] [browserFetch] → loading ${url}`);

    // Load the URL. Don't set a custom UA — use Chromium's default UA
    // which looks like a real browser.
    await win.loadURL(url);

    // After loadURL resolves, we might be on the Cloudflare challenge page.
    // Wait for it to auto-resolve (JS runs, cookie is set, redirect happens).
    const startTime = Date.now();
    while (Date.now() - startTime < NAVIGATION_TIMEOUT_MS) {
      await new Promise((r) => setTimeout(r, 1000));

      const currentHtml = await win.webContents
        .executeJavaScript('document.documentElement.outerHTML')
        .catch(() => '');

      // If the page no longer looks like a challenge, we're good.
      if (
        currentHtml.length > 5000 &&
        !currentHtml.includes('Just a moment...') &&
        !currentHtml.includes('cf-challenge') &&
        !currentHtml.includes('challenge-platform')
      ) {
        if (DEBUG)
          log.browserFetch.info(
            `[${ts()}] [browserFetch] ← page settled (${currentHtml.length} bytes) after ${Date.now() - startTime}ms`,
          );
        return currentHtml;
      }

      if (DEBUG && Date.now() - startTime < 6000) {
        log.browserFetch.info(
          `[${ts()}] [browserFetch] ⏳ waiting for Cloudflare... (${currentHtml.length} bytes)`,
        );
      }
    }

    // Timeout — extract whatever we have.
    const html = await win.webContents
      .executeJavaScript('document.documentElement.outerHTML')
      .catch(() => '');

    if (DEBUG)
      log.browserFetch.warn(
        `[${ts()}] [browserFetch] ⏱ timeout after ${NAVIGATION_TIMEOUT_MS}ms — got ${html.length} bytes`,
      );

    if (html && html.length > 5000) {
      return html; // might still be usable
    }

    throw new Error(
      `Cloudflare challenge not resolved within ${NAVIGATION_TIMEOUT_MS}ms (got ${html?.length ?? 0} bytes)`,
    );
  } catch (err) {
    crashed = true;
    if (DEBUG)
      log.browserFetch.warn(
        `[${ts()}] [browserFetch] ✗ error on ${url}:` +
          ' ' +
          (err instanceof Error ? err.message : String(err)),
      );
    throw err;
  } finally {
    releaseWindow(domain, win, crashed);
  }
}

// ──────────────────────────────────────────────────────────────────────────
// browserGraphqlFetch — execute a GraphQL fetch from inside a hidden
// BrowserWindow's page context.
//
// IMDB's GraphQL endpoint (api.graphql.imdb.com) is fronted by AWS WAF,
// which rejects anonymous requests with a misleading HTTP 415
// "Invalid content type, must be application/json" — regardless of whether
// we use GET or POST, regardless of which persisted query hash we send.
//
// The WAF only admits requests that carry the `aws-waf-token` cookie,
// which is minted by challenge.js when a real browser visits imdb.com.
// Our hidden BrowserWindow already runs real Chromium JS, so it solves
// the challenge automatically.
//
// The trick: instead of trying to extract the WAF cookie and pass it to
// a plain fetch(), we run the fetch() call FROM INSIDE the page's own
// JavaScript context via webContents.executeJavaScript(). The fetch
// automatically inherits:
//   - The page's cookies (including aws-waf-token)
//   - The page's origin (https://www.imdb.com → same-site to api.graphql.imdb.com)
//   - The browser's TLS fingerprint (real Chromium)
//   - The browser's default headers (sec-fetch-*, User-Agent, etc.)
//
// Cost: one hidden BrowserWindow open for the duration of the fetch
// (typically 200-500ms after the WAF is cleared on first call; the WAF
// cookie is persisted in the partition so subsequent calls skip the
// challenge entirely).
// ──────────────────────────────────────────────────────────────────────────

/**
 * Execute a GraphQL fetch from inside a hidden BrowserWindow loaded with
 * the same origin as the GraphQL endpoint. Required for IMDB's AWS WAF.
 *
 * Supports two modes:
 *
 * 1. **POST mode** (for `api.graphql.imdb.com`): pass a `requestBody`
 *    object. The fetch will be POST with `Content-Type: application/json`
 *    and the body will be JSON.stringify'd. Required because that endpoint
 *    rejects GET requests with HTTP 415 "Invalid content type, must be
 *    application/json".
 *
 * 2. **GET mode** (for `caching.graphql.imdb.com`): omit `requestBody`. The
 *    fetch will be GET with no Content-Type header. The persisted query
 *    params must already be in `graphqlUrl`'s query string. This variant
 *    is CDN-cacheable and is what imdb.com uses for public charts/lists
 *    (Top 250, Box Office, etc.) — those are anonymous-safe.
 *
 * @param graphqlUrl  The full GraphQL URL. For GET mode, include
 *                    `?operationName=...&variables=...&extensions=...` in
 *                    the query string. For POST mode, just the bare URL.
 * @param originPage  A page on the same origin as the GraphQL endpoint
 *                    (e.g. 'https://www.imdb.com/') — the hidden window
 *                    loads this page first to clear the WAF and accumulate
 *                    cookies, then executes the fetch.
 * @param requestBody Optional. If provided, send as POST with JSON body.
 *                    If omitted, send as GET with no body.
 * @returns           The response body as text (usually JSON).
 */
export async function browserGraphqlFetch(
  graphqlUrl: string,
  originPage: string,
  requestBody?: object,
): Promise<string> {
  return withNetworkTracking(() => browserGraphqlFetchImpl(graphqlUrl, originPage, requestBody));
}

async function browserGraphqlFetchImpl(
  graphqlUrl: string,
  originPage: string,
  requestBody?: object,
): Promise<string> {
  const domain = extractDomain(originPage);
  const partition = `browserfetch-${domain}`;

  const win = acquireWindow(domain, partition);
  let crashed = false;

  try {
    if (DEBUG)
      log.browserFetch.info(`[${ts()}] [browserGraphqlFetch] → loading origin page: ${originPage}`);
    await win.loadURL(originPage);

    // Wait for the WAF challenge (if any) to resolve. The page's challenge.js
    // will mint the aws-waf-token cookie and reload. We detect completion by
    // checking that the page content is no longer the challenge HTML.
    const startTime = Date.now();
    while (Date.now() - startTime < NAVIGATION_TIMEOUT_MS) {
      const currentHtml = await win.webContents
        .executeJavaScript('document.documentElement.outerHTML')
        .catch(() => '');

      if (
        currentHtml.length > 5000 &&
        !currentHtml.includes('awsWafCookie') &&
        !currentHtml.includes('challenge-container') &&
        !currentHtml.includes('Just a moment...')
      ) {
        if (DEBUG)
          log.browserFetch.info(
            `[${ts()}] [browserGraphqlFetch] ← WAF cleared after ${Date.now() - startTime}ms (${currentHtml.length} bytes)`,
          );
        break;
      }
      await new Promise((r) => setTimeout(r, 500));
    }

    // Now execute the GraphQL fetch from inside the page's context.
    const isPost = requestBody !== undefined;
    const bodyJson = isPost ? JSON.stringify(requestBody) : '';

    if (DEBUG) {
      log.browserGraphqlFetch.info(
        `[browserGraphqlFetch] → ${isPost ? 'POST' : 'GET'} to ${graphqlUrl}` +
          (isPost ? ` (${bodyJson.length} bytes body)` : ''),
      );
    }

    const fetchScript = isPost
      ? `
        (async () => {
          try {
            const r = await fetch(${JSON.stringify(graphqlUrl)}, {
              method: 'POST',
              credentials: 'include',
              headers: {
                'Accept': 'application/graphql+json, application/json',
                'Content-Type': 'application/json',
              },
              body: ${JSON.stringify(bodyJson)},
            });
            const text = await r.text();
            return { status: r.status, ok: r.ok, body: text };
          } catch (err) {
            return { status: 0, ok: false, body: '', error: String(err) };
          }
        })()
      `
      : `
        (async () => {
          try {
            const r = await fetch(${JSON.stringify(graphqlUrl)}, {
              method: 'GET',
              credentials: 'include',
              headers: {
                'Accept': 'application/graphql+json, application/json',
                'Content-Type': 'application/json',
                'x-imdb-client-name': 'imdb-web-next',
                'x-imdb-user-language': 'fr-FR',
                'x-imdb-user-country': 'FR',
              },
            });
            const text = await r.text();
            return { status: r.status, ok: r.ok, body: text };
          } catch (err) {
            return { status: 0, ok: false, body: '', error: String(err) };
          }
        })()
      `;

    const result = await win.webContents.executeJavaScript(fetchScript);

    if (!result || typeof result !== 'object') {
      throw new Error('browserGraphqlFetch: executeJavaScript returned no result');
    }

    if (result.error) {
      throw new Error(`browserGraphqlFetch: in-page fetch threw: ${result.error}`);
    }

    if (!result.ok) {
      throw new Error(
        `browserGraphqlFetch: HTTP ${result.status} — ${result.body?.substring(0, 200) ?? ''}`,
      );
    }

    if (DEBUG)
      log.browserFetch.info(
        `[${ts()}] [browserGraphqlFetch] ← HTTP ${result.status} (${result.body?.length ?? 0} bytes)`,
      );
    return result.body ?? '';
  } catch (err) {
    crashed = true;
    if (DEBUG)
      log.browserFetch.warn(
        `[${ts()}] [browserGraphqlFetch] ✗ error:` +
          ' ' +
          (err instanceof Error ? err.message : String(err)),
      );
    throw err;
  } finally {
    releaseWindow(domain, win, crashed);
  }
}
