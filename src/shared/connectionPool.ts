import { fetchWithTimeout, REQUEST_TIMEOUT_MS } from './fetchWithTimeout';
import { withNetworkTracking } from './networkActivity';
import { simpleLog as log } from './simpleLogger';

// ──────────────────────────────────────────────────────────────────────────
// Connection pool with per-domain rate limiting + detailed logging.
//
// Each domain gets its own queue with a minimum delay between requests.
// Requests to the same domain are SERIALIZED (one at a time, with delay).
// Requests to different domains run in parallel.
//
// All requests are logged with HTTP status, response size, and timing
// when ARVE_DEBUG=1.
// ──────────────────────────────────────────────────────────────────────────

/** Format a timestamp for debug logs: HH:MM:ss.sss */


const DEBUG = process.env.ARVE_DEBUG === '1';

function debug(...args: unknown[]) { if (DEBUG) log.info(args.join(" ")); }

interface DomainState {
  lastRequestTime: number;
  /** Promise chain that serializes requests to this domain.
   *  Each request awaits this before starting, ensuring one-at-a-time. */
  chain: Promise<void>;
}

const domains = new Map<string, DomainState>();

const DEFAULT_DOMAIN_DELAY_MS = 2000;

function extractDomain(url: string): string {
  try { return new URL(url).hostname; }
  catch { return 'unknown'; }
}

export interface FetchOptions {
  domainDelayMs?: number;
  timeoutMs?: number;
  headers?: Record<string, string>;
  /**
   * Set to `true` for JSON API endpoints whose response may legitimately be
   * small (<200 bytes) — e.g. a GraphQL endpoint returning an empty `data`
   * object. When true, the Cloudflare-detection heuristic skips the
   * byte-count floor and only triggers on the explicit Cloudflare markers.
   *
   * Defaults to `false` (HTML endpoints — short responses are suspicious).
   */
  allowShortResponse?: boolean;
  /** HTTP method. Defaults to `'GET'`. Set to `'POST'` to send a body. */
  method?: 'GET' | 'POST';
  /** Request body. Used only when `method === 'POST'`. */
  body?: string;
}

/** Fetch a URL with per-domain rate limiting and detailed logging.
 *  Returns the response text, or throws with a descriptive error.
 *  Wrapped in `withNetworkTracking` so the renderer's refresh-icon spinner
 *  knows when network activity is in flight. */
export async function pooledFetch(url: string, opts: FetchOptions = {}): Promise<string> {
  return withNetworkTracking(() => pooledFetchImpl(url, opts));
}

async function pooledFetchImpl(url: string, opts: FetchOptions = {}): Promise<string> {
  const domain = extractDomain(url);
  const delay = opts.domainDelayMs ?? DEFAULT_DOMAIN_DELAY_MS;
  const timeout = opts.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const headers = opts.headers ?? {};

  // Get or create the domain state.
  let state = domains.get(domain);
  if (!state) {
    state = { lastRequestTime: 0, chain: Promise.resolve() };
    domains.set(domain, state);
  }

  // Serialize: chain this request after the previous one for this domain.
  // This is the correct way to ensure one-at-a-time per domain — the
  // previous implementation used a `pending` field that could race.
  const prevChain = state.chain;
  let resolveChain!: () => void;
  state.chain = new Promise<void>(resolve => { resolveChain = resolve; });

  try {
    // Wait for the previous request to this domain to complete.
    await prevChain;

    // Enforce the delay since the last request.
    const now = Date.now();
    const elapsed = now - state.lastRequestTime;
    const waitMs = Math.max(0, delay - elapsed);
    if (waitMs > 0) {
      debug(`⏳ ${domain}: waiting ${waitMs}ms (rate limit)`);
      await new Promise(r => setTimeout(r, waitMs));
    }

    // Execute the request.
    const startTime = Date.now();
    const method = opts.method ?? 'GET';
    const reqBody = opts.body;
    debug(`→ ${method} ${url}` + (reqBody ? ` (${reqBody.length} bytes body)` : ''));
    debug(`  headers: ${JSON.stringify(headers)}`);

    const res = await fetchWithTimeout(
      url,
      { headers, method, ...(reqBody !== undefined ? { body: reqBody } : {}) },
      timeout,
    );
    const elapsedMs = Date.now() - startTime;
    state.lastRequestTime = Date.now();

    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      debug(`← HTTP ${res.status} in ${elapsedMs}ms (${errBody.length} bytes)`);
      throw new Error(`HTTP ${res.status} — ${res.statusText}${errBody.length < 200 ? ': ' + errBody.slice(0, 200) : ''}`);
    }

    const text = await res.text();
    debug(`← HTTP ${res.status} in ${elapsedMs}ms (${text.length} bytes)`);

    // Detect Cloudflare challenge. Cloudflare's "Just a moment..." interstitial
    // page is small (typically ~3-5 KB of obfuscated JS), but legitimate pages
    // can also be short (e.g. a 204 No Content or a tiny redirect stub). Using a
    // 500-byte threshold produced false positives on small but valid responses.
    // We now trigger on the explicit Cloudflare markers AND a very low floor
    // (<200 bytes, which is essentially "empty" — no real HTML page is that small).
    //
    // JSON API callers (e.g. the IMDB GraphQL endpoint) can opt out of the
    // byte-count floor via `allowShortResponse: true` because their empty
    // responses are legitimately tiny (e.g. `{"data":{"titles":[]}}` is ~30
    // bytes) and would otherwise false-positive as a Cloudflare challenge.
    const allowShort = opts.allowShortResponse === true;
    const isCloudflareChallenge =
      text.includes('Just a moment...') ||
      text.includes('cf-challenge') ||
      text.includes('challenge-platform') ||
      text.includes('cf-browser-verification') ||
      (!allowShort && text.length < 200);
    if (isCloudflareChallenge) {
      debug(`⚠ ${domain}: Cloudflare challenge detected (${text.length} bytes)`);
      throw new Error(`Cloudflare challenge (${text.length} bytes) — likely IP-blocked`);
    }

    return text;
  } catch (err) {
    if (err instanceof Error && err.name === 'TimeoutError') {
      debug(`⏱ TIMEOUT after ${timeout}ms on ${url}`);
    } else {
      debug(`✗ ERROR on ${url}: ${err instanceof Error ? err.message : String(err)}`);
    }
    throw err;
  } finally {
    // Release the chain so the next request can proceed.
    resolveChain();
  }
}

/** Reset all domain queues. */
export function resetConnectionPool(): void {
  domains.clear();
}
