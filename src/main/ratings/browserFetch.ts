import { BrowserWindow, session } from 'electron';

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

/** Fetch a URL via a hidden BrowserWindow. Returns the full page HTML. */
export async function browserFetch(
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
      images: true,
      javascript: true,
    },
  });

  // Harden the hidden window: deny all window-open + navigation + permission
  // requests. This window is only ever used to load ONE URL we control (the
  // Cloudflare-protected page we're scraping); any other navigation is by
  // definition an attack vector (e.g. a malicious redirect from a
  // compromised page trying to escape the hidden window).
  win.webContents.setWindowOpenHandler(({ url }) => {
    console.warn(`[browserFetch] blocked window-open to: ${url}`);
    return { action: 'deny' };
  });
  // will-navigate fires for in-page navigations (link clicks, location.href
  // assignments, form submits) but NOT for the initial loadURL nor for
  // server-side redirects (those use will-redirect below). Deny unconditionally.
  win.webContents.on('will-navigate', (event, url) => {
    event.preventDefault();
    console.warn(`[browserFetch] blocked will-navigate to: ${url}`);
  });
  // will-redirect fires for HTTP 3xx redirects. Cloudflare challenges
  // legitimately redirect within their own domain before reaching the real
  // page, so we allow same-registrable-domain redirects but block
  // cross-domain jumps (which would indicate compromise or captive-portal
  // hijack).
  win.webContents.on('will-redirect', (event, url) => {
    try {
      const initialHost = new URL(initialUrl).hostname;
      const redirectHost = new URL(url).hostname;
      if (redirectHost === initialHost ||
          redirectHost.endsWith('.' + initialHost) ||
          initialHost.endsWith('.' + redirectHost)) {
        return;  // allowed — same registrable domain
      }
    } catch { /* fall through to block */ }
    event.preventDefault();
    console.warn(`[browserFetch] blocked will-redirect to: ${url}`);
  });
  ses.setPermissionRequestHandler(() => false);
  ses.setPermissionCheckHandler(() => false);

  try {
    if (DEBUG) console.log(`[browserFetch] → loading ${url}`);

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
        if (DEBUG) console.log(`[browserFetch] ← page settled (${currentHtml.length} bytes) after ${Date.now() - startTime}ms`);
        return currentHtml;
      }

      if (DEBUG && Date.now() - startTime < 6000) {
        console.log(`[browserFetch] ⏳ waiting for Cloudflare... (${currentHtml.length} bytes)`);
      }
    }

    // Timeout — extract whatever we have.
    const html = await win.webContents.executeJavaScript(
      'document.documentElement.outerHTML'
    ).catch(() => '');

    if (DEBUG) console.warn(`[browserFetch] ⏱ timeout after ${NAVIGATION_TIMEOUT_MS}ms — got ${html.length} bytes`);

    if (html && html.length > 5000) {
      return html;   // might still be usable
    }

    throw new Error(`Cloudflare challenge not resolved within ${NAVIGATION_TIMEOUT_MS}ms (got ${html?.length ?? 0} bytes)`);
  } catch (err) {
    if (DEBUG) console.warn(`[browserFetch] ✗ error on ${url}:`, err);
    throw err;
  } finally {
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
