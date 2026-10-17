import { getDomain } from 'tldts';

// ──────────────────────────────────────────────────────────────────────────
// Navigation policy for child/auxiliary webContents (review SEC-01).
//
// The previous check was a suffix heuristic on hostnames that treated any
// "parent/child" host relationship as same-domain: from `www.allocine.fr`
// it allowed a top-level navigation to `https://fr/`, and it could never
// tell a real registrable domain from a public suffix. This module replaces
// it with an explicit, tested policy:
//
//   1. Only http/https top-level navigations may be considered at all.
//   2. Both the CURRENT host (what the aux window is on) and the TARGET
//      host must map to a registrable domain (via tldts/PSL) that is in
//      the configured allow-list — i.e. both sides must be "ours".
//      A window that already sits on a non-approved host cannot navigate
//      anywhere (it can't be steered off-content by remote markup).
//   3. IP literals and single-label / private hosts map to no registrable
//     domain → denied. Local host never needs aux-window navigation; dev
//     origins are handled separately by the MAIN window policy.
//
// The allow-list is data, provided by the composition root (index.ts):
// registrable domains of every configured cinema baseUrl (builtin AND
// custom — rebuilt when cinemas change) plus the rating-provider hosts
// the browserFetch pool performs WAF challenges on (allocine.fr,
// rottentomatoes.com, imdb.com).
//
// Redirects: will-navigate decisions alone don't cover HTTP redirects —
// `will-redirect` fires on those. The same decision function must be
// applied there (index.ts does; see the contract test).
// ──────────────────────────────────────────────────────────────────────────

/** The rating-provider hosts hidden browserFetch windows reach for WAF
 *  challenges. Keeping them explicit (not derived) is the point: a change
 *  here is a policy change, reviewed as such. */
export const RATING_PROVIDER_DOMAINS = ['allocine.fr', 'rottentomatoes.com', 'imdb.com'] as const;

export type NavDecision = { allowed: boolean; reason: string };

/** Extract the registrable domain (eTLD+1, PSL-aware) from a URL string,
 *  or null for IP literals, private hosts, and garbage. */
export function registrableDomainOf(url: string): string | null {
  let host: string;
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    host = u.hostname;
  } catch {
    return null;
  }
  if (!host || host.includes(':')) return null; // IPv6 literal
  // tldts: IPv4_literals and unknown/private patterns → null-ish results.
  const domain = getDomain(host, { allowPrivateDomains: false, detectIp: true });
  return domain;
}

/**
 * Build the allowed registrable-domain set: every cinema's baseUrl host
 * (builtin + custom) mapped to PSL eTLD+1, plus the static provider
 * domains. Invalid/unparseable baseUrl entries are simply skipped — the
 * policy can never be widened by config mistakes.
 */
export function buildAllowedChildDomains(cinemaBaseUrls: Iterable<string>): Set<string> {
  const allowed = new Set<string>(RATING_PROVIDER_DOMAINS);
  for (const raw of cinemaBaseUrls) {
    const d = registrableDomainOf(raw);
    if (d) allowed.add(d);
  }
  return allowed;
}

/**
 * Decide a child-window top-level navigation (and redirects — apply the
 * same function on 'will-redirect'). `referenceUrl` is what the contents
 * currently displays; `targetUrl` is where it wants to go.
 */
export function isChildNavigationAllowed(
  referenceUrl: string,
  targetUrl: string,
  allowedDomains: ReadonlySet<string>,
): NavDecision {
  // Both sides of the edge must be known content. A window sitting on a
  // host we did not provision (e.g. challenge page parked on a CDN host)
  // may not navigate anywhere — remote markup cannot steer it.
  const refDomain = referenceUrl ? registrableDomainOf(referenceUrl) : null;
  if (!refDomain) {
    return { allowed: false, reason: 'current host is not an approved domain' };
  }
  if (!allowedDomains.has(refDomain)) {
    return { allowed: false, reason: `current host domain ${refDomain} is not allow-listed` };
  }
  const targetDomain = registrableDomainOf(targetUrl);
  if (!targetDomain) {
    return { allowed: false, reason: 'target has no registrable domain (scheme, IP or malformed)' };
  }
  if (!allowedDomains.has(targetDomain)) {
    return { allowed: false, reason: `target domain ${targetDomain} is not allow-listed` };
  }
  // Same registrable domain (or cross-domain hops BETWEEN allow-listed
  // providers, e.g. cinema site → allocine)? Allowed.
  return { allowed: true, reason: `both sides allow-listed (${refDomain} → ${targetDomain})` };
}
