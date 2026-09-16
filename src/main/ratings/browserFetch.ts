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
      // DON'T disable images — Cloudflare detects this as bot behavior.
      images: true,
      // DON'T disable JavaScript — needed for Cloudflare challenge.
      javascript: true,
    },
  });

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
