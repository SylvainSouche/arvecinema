import { BrowserWindow, session } from 'electron';
import { withNetworkTracking } from './networkActivity';

// ──────────────────────────────────────────────────────────────────────────
// browserFetch — fetch a URL using a hidden Electron BrowserWindow.
//
// Bypasses Cloudflare by loading the page in a real Chromium browser.
// Key anti-detection measures:
//   - images: true (Cloudflare detects bots that skip images)
//   - sandbox: true (real browser sandbox)
//   - Real User-Agent from the session (not a custom UA that looks fake)
//   - Wait for navigation to settle (challenge → redirect → real page)
// ──────────────────────────────────────────────────────────────────────────

const DEBUG = process.env.ARVE_DEBUG === '1';
const NAVIGATION_TIMEOUT_MS = 20_000;

/** Format a timestamp for debug logs: HH:MM:ss.sss */
function ts(): string {
  const d = new Date();
  return d.toLocaleTimeString('en-GB', { hour12: false }) + '.' + String(d.getMilliseconds()).padStart(3, '0');
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
    return BLOCKED_DOMAIN_PATTERNS.some(
      d => hostname === d || hostname.endsWith('.' + d),
    );
  } catch {
    return false;
  }
}

/** Install the ad-blocker on a session. Returns a disposer that removes the listener. */
function installAdBlocker(ses: Electron.Session): () => void {
  // onBeforeRequest fires for every network request (main frame, sub-frame,
  // image, script, XHR, fetch, etc.). We return { cancel: true } for
  // tracker domains — the request never leaves the process.
  //
  // NOTE: Electron's onBeforeRequest returns `void` (not a filter object)
  // when using the callback form. To dispose, we use the same session's
  // `webRequest` API to clear the listener. The listener is auto-cleared
  // when the session's last referencing BrowserWindow is destroyed, but we
  // also keep a manual disposer for explicit teardown.
  ses.webRequest.onBeforeRequest(
    (details, callback) => {
      if (shouldBlockUrl(details.url)) {
        if (DEBUG && Math.random() < 0.05) {
          // Sample 5% of blocks to avoid log spam when many trackers fire at once.
          console.log(`[${ts()}] [browserFetch] blocked tracker: ${details.url.substring(0, 80)}...`);
        }
        callback({ cancel: true });
      } else {
        callback({});
      }
    },
  );
  // Return a disposer that clears all onBeforeRequest listeners on the session.
  return () => {
    try { ses.webRequest.onBeforeRequest(() => {}); } catch { /* ignore */ }
  };
}

/** Returns true if `url` is on the same registrable domain as `initialUrl`. */
function isSameRegistrableDomain(initialUrl: string, url: string): boolean {
  try {
    const initialHost = new URL(initialUrl).hostname;
    const redirectHost = new URL(url).hostname;
    return redirectHost === initialHost ||
      redirectHost.endsWith('.' + initialHost) ||
      initialHost.endsWith('.' + redirectHost);
  } catch {
    return false;
  }
}

/** Fetch a URL via a hidden BrowserWindow. Returns the full page HTML.
 *  Wrapped in `withNetworkTracking` so the renderer's refresh-icon spinner
 *  knows when network activity is in flight. */
export async function browserFetch(
  url: string,
  _opts: { headers?: Record<string, string>; referer?: string } = {},
): Promise<string> {
  return withNetworkTracking(() => browserFetchImpl(url, _opts));
}

async function browserFetchImpl(
  url: string,
  _opts: { headers?: Record<string, string>; referer?: string } = {},
): Promise<string> {
  // Capture the initial URL for redirect-policy enforcement below — we only
  // allow redirects within the same registrable domain as the original target.
  const initialUrl = url;

  // Use a persistent partition per-domain so Cloudflare cookies persist
  // between requests to the same site (Cloudflare sets a cf_clearance
  // cookie that lasts ~30 min — reusing it means subsequent requests
  // skip the challenge entirely).
  const domain = extractDomain(url);
  const partition = `browserfetch-${domain}`;

  const ses = session.fromPartition(partition);

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
      // JavaScript execution (challenge.js), NOT by image loading. We
      // verified this works with `browserGraphqlFetch` (which already
      // uses `images: false`). Disabling images:
      //   - Cuts page load time from ~2-5s to ~500ms (no poster/ad fetches)
      //   - Eliminates the noisy `ffmpeg_common.cc: Unsupported pixel
      //     format: -1` errors (Chromium trying to decode AVIF/HEIC images)
      //   - Reduces bandwidth (each imdb/allocine page loads ~20-50 images)
      //   - Skips the ad network's image-based tracking pixels entirely
      images: false,
      javascript: true,
    },
  });

  // Harden the hidden window: deny all window-open + navigation + permission
  // requests. This window is only ever used to load ONE URL we control (the
  // Cloudflare-protected page we're scraping); any other navigation is by
  // definition an attack vector (e.g. a malicious redirect from a
  // compromised page trying to escape the hidden window).
  //
  // EXCEPTION: same-registrable-domain navigations are allowed, because
  // Cloudflare/AWS WAF challenge scripts often call window.location.reload()
  // to apply the freshly minted cookie. Without this exception, the WAF
  // reload gets blocked and the cookie is never set.
  win.webContents.setWindowOpenHandler(({ url }) => {
    console.warn(`[${ts()}] [browserFetch] blocked window-open to: ${url}`);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (isSameRegistrableDomain(initialUrl, url)) return;  // allow WAF reload
    event.preventDefault();
    console.warn(`[${ts()}] [browserFetch] blocked will-navigate to: ${url}`);
  });
  win.webContents.on('will-redirect', (event, url) => {
    if (isSameRegistrableDomain(initialUrl, url)) return;  // allow same-domain
    event.preventDefault();
    console.warn(`[${ts()}] [browserFetch] blocked will-redirect to: ${url}`);
  });
  ses.setPermissionRequestHandler(() => false);
  ses.setPermissionCheckHandler(() => false);

  // Install the ad/tracker blocker — blocks parasitic requests to
  // amazon-adsystem.com, doubleclick.net, etc. at the network layer so they
  // never leave the process.
  const disposeAdBlocker = installAdBlocker(ses);

  try {
    if (DEBUG) console.log(`[${ts()}] [browserFetch] → loading ${url}`);

    // Load the URL. Don't set a custom UA — use Chromium's default UA
    // which looks like a real browser.
    await win.loadURL(url);

    // After loadURL resolves, we might be on the Cloudflare challenge page.
    // Wait for it to auto-resolve (JS runs, cookie is set, redirect happens).
    // We poll the URL — once it stops containing "challenge" or "just a moment",
    // we're on the real page.
    const startTime = Date.now();
    while (Date.now() - startTime < NAVIGATION_TIMEOUT_MS) {
      await new Promise(r => setTimeout(r, 1000));

      // Check the current page content
      const currentHtml = await win.webContents.executeJavaScript(
        'document.documentElement.outerHTML'
      ).catch(() => '');

      // If the page no longer looks like a challenge, we're good.
      if (currentHtml.length > 5000 &&
          !currentHtml.includes('Just a moment...') &&
          !currentHtml.includes('cf-challenge') &&
          !currentHtml.includes('challenge-platform')) {
        if (DEBUG) console.log(`[${ts()}] [browserFetch] ← page settled (${currentHtml.length} bytes) after ${Date.now() - startTime}ms`);
        return currentHtml;
      }

      if (DEBUG && Date.now() - startTime < 6000) {
        console.log(`[${ts()}] [browserFetch] ⏳ waiting for Cloudflare... (${currentHtml.length} bytes)`);
      }
    }

    // Timeout — extract whatever we have.
    const html = await win.webContents.executeJavaScript(
      'document.documentElement.outerHTML'
    ).catch(() => '');

    if (DEBUG) console.warn(`[${ts()}] [browserFetch] ⏱ timeout after ${NAVIGATION_TIMEOUT_MS}ms — got ${html.length} bytes`);

    if (html && html.length > 5000) {
      return html;   // might still be usable
    }

    throw new Error(`Cloudflare challenge not resolved within ${NAVIGATION_TIMEOUT_MS}ms (got ${html?.length ?? 0} bytes)`);
  } catch (err) {
    if (DEBUG) console.warn(`[${ts()}] [browserFetch] ✗ error on ${url}:`, err);
    throw err;
  } finally {
    disposeAdBlocker();
    // Destroy the window but DON'T clear the session — Cloudflare's
    // cf_clearance cookie is stored in the partition and will be reused
    // on the next request to the same domain.
    win.destroy();
  }
}

function extractDomain(url: string): string {
  try { return new URL(url).hostname; }
  catch { return 'default'; }
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
// This is the ONLY way to reach api.graphql.imdb.com anonymously — short
// of running a full headless browser per request, which we're already
// doing here anyway.
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
  return withNetworkTracking(() =>
    browserGraphqlFetchImpl(graphqlUrl, originPage, requestBody),
  );
}

async function browserGraphqlFetchImpl(
  graphqlUrl: string,
  originPage: string,
  requestBody?: object,
): Promise<string> {
  const initialUrl = originPage;
  const domain = extractDomain(originPage);
  const partition = `browserfetch-${domain}`;
  const ses = session.fromPartition(partition);

  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 800,
    webPreferences: {
      session: ses,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      images: false,    // skip images — we only need JS to run for WAF
      javascript: true,
    },
  });

  // Same hardening as browserFetch.
  win.webContents.setWindowOpenHandler(({ url }) => {
    console.warn(`[${ts()}] [browserGraphqlFetch] blocked window-open to: ${url}`);
    return { action: 'deny' };
  });
  // Allow same-domain navigations (WAF challenge.js calls
  // window.location.reload() to apply the cookie — must not be blocked).
  win.webContents.on('will-navigate', (event, url) => {
    if (isSameRegistrableDomain(initialUrl, url)) return;
    event.preventDefault();
    console.warn(`[${ts()}] [browserGraphqlFetch] blocked will-navigate to: ${url}`);
  });
  win.webContents.on('will-redirect', (event, url) => {
    if (isSameRegistrableDomain(initialUrl, url)) return;
    event.preventDefault();
    console.warn(`[${ts()}] [browserGraphqlFetch] blocked will-redirect to: ${url}`);
  });
  ses.setPermissionRequestHandler(() => false);
  ses.setPermissionCheckHandler(() => false);

  // Block tracker/ad requests at the network layer.
  const disposeAdBlocker = installAdBlocker(ses);

  try {
    if (DEBUG) console.log(`[${ts()}] [browserGraphqlFetch] → loading origin page: ${originPage}`);
    await win.loadURL(originPage);

    // Wait for the WAF challenge (if any) to resolve. The page's challenge.js
    // will mint the aws-waf-token cookie and reload. We detect completion by
    // checking that the page content is no longer the challenge HTML.
    const startTime = Date.now();
    while (Date.now() - startTime < NAVIGATION_TIMEOUT_MS) {
      const currentHtml = await win.webContents.executeJavaScript(
        'document.documentElement.outerHTML'
      ).catch(() => '');

      // Challenge HTML is small and contains these markers. Once they're
      // gone and the page is reasonably sized, we're through.
      if (currentHtml.length > 5000 &&
          !currentHtml.includes('awsWafCookie') &&
          !currentHtml.includes('challenge-container') &&
          !currentHtml.includes('Just a moment...')) {
        if (DEBUG) console.log(`[${ts()}] [browserGraphqlFetch] ← WAF cleared after ${Date.now() - startTime}ms (${currentHtml.length} bytes)`);
        break;
      }
      await new Promise(r => setTimeout(r, 500));
    }

    // Now execute the GraphQL fetch from inside the page's context.
    // The fetch inherits all cookies (including aws-waf-token), the page's
    // origin, and the browser's TLS/UA fingerprint.
    //
    // Method depends on whether a body was provided:
    //   - With body: POST with `Content-Type: application/json` (for
    //     `api.graphql.imdb.com` — rejects GET with 415).
    //   - Without body: GET with no Content-Type (for
    //     `caching.graphql.imdb.com` — CDN-cached, anonymous-safe, allows
    //     GET with persisted query params in URL).
    const isPost = requestBody !== undefined;
    const bodyJson = isPost ? JSON.stringify(requestBody) : '';

    if (DEBUG) {
      console.log(
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
                // IMDB's backend REQUIRES 'Content-Type: application/json' on
                // ALL requests, even GETs with no body. Without it, the
                // response is HTTP 415 "Invalid content type, must be
                // application/json". Confirmed via the browser's CORS
                // preflight (access-control-request-headers includes
                // 'content-type' for GET requests).
                'Content-Type': 'application/json',
                // Required client-identification headers — the browser
                // sends all of these on every imdb.com GraphQL request
                // (captured from CORS preflight). Without 'x-imdb-client-name'
                // the WAF rejects as "unknown client".
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
      throw new Error(`browserGraphqlFetch: HTTP ${result.status} — ${result.body?.substring(0, 200) ?? ''}`);
    }

    if (DEBUG) console.log(`[${ts()}] [browserGraphqlFetch] ← HTTP ${result.status} (${result.body?.length ?? 0} bytes)`);
    return result.body ?? '';
  } catch (err) {
    if (DEBUG) console.warn(`[${ts()}] [browserGraphqlFetch] ✗ error:`, err);
    throw err;
  } finally {
    disposeAdBlocker();
    win.destroy();
  }
}
