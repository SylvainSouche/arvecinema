// ──────────────────────────────────────────────────────────────────────────
// navigationPolicy tests — child-window navigation decisions (SEC-01).
//
// The old suffix heuristic treated parent/child host chunks as same-domain
// (www.allocine.fr could navigate to `https://fr/`, co.uk would pass as a
// "parent"). These tests pin the PSL-based policy boundary by boundary.
// tldts ships the Public Suffix List, so the tricky real-world cases
// (multi-label suffixes) are genuinely exercised.
// ──────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from 'vitest';
import {
  buildAllowedChildDomains,
  isChildNavigationAllowed,
  registrableDomainOf,
  RATING_PROVIDER_DOMAINS,
} from '../../src/main/navigationPolicy';

const ALLOWED = new Set(['allocine.fr', 'rottentomatoes.com', 'imdb.com', 'cinevox-annecy.fr']);

const allow = isChildNavigationAllowed;
const ok = (ref: string, target: string, set = ALLOWED) => allow(ref, target, set);
const expectTrue = (ref: string, target: string, set = ALLOWED) =>
  expect(ok(ref, target, set).allowed).toBe(true);
const expectFalse = (ref: string, target: string, set = ALLOWED) => {
  const d = ok(ref, target, set);
  expect(d.allowed).toBe(false);
};

describe('navigationPolicy: registrableDomainOf (tldts/PSL)', () => {
  it('resolves multi-label TLDs correctly (co.uk trap closed)', () => {
    expect(registrableDomainOf('https://foo.co.uk/page')).toBe('foo.co.uk');
    expect(registrableDomainOf('https://www.allocine.fr/film/ex')).toBe('allocine.fr');
    expect(registrableDomainOf('https://api.github.com')).toBe('github.com');
  });

  it('denies IP literals, no-host schemes and malformed URLs', () => {
    expect(registrableDomainOf('https://192.168.0.1/')).toBeNull();
    expect(registrableDomainOf('http://[::1]:8080/')).toBeNull();
    expect(registrableDomainOf('file:///C:/app/index.html')).toBeNull();
    expect(registrableDomainOf('not a url')).toBeNull();
    expect(registrableDomainOf('chrome-extension://abc/x')).toBeNull();
  });
});

describe('navigationPolicy: child navigations', () => {
  it('allows subdomain reloads within one cinema domain (WAF/Cloudflare case)', () => {
    expectTrue('https://www.allocine.fr/film/', 'https://www.allocine.fr/film/x');
    expectTrue('https://allocine.fr/', 'https://loadbalancer.allocine.fr/x');
  });

  it('allows cross-provider hops between allow-listed domains', () => {
    expectTrue('https://www.allocine.fr/', 'https://www.rottentomatoes.com/m/x');
  });

  it('denies navigation OUT of the approved domains (steering a challenge window)', () => {
    expectFalse('https://www.allocine.fr/', 'https://evil.example/payload');
    // …including the suffix trap that the old heuristic let through:
    expectFalse('https://www.allocine.fr/', 'https://evil.allocine.fr.evil.example/');
  });

  it('denies navigation FROM an unapproved current host (remote markup stuck there)', () => {
    expectFalse('https://evil.example/', 'https://www.allocine.fr/');
  });

  it('the OLD heuristic hole is closed: https://fr/ is not treated as a parent of allocine.fr', () => {
    expectFalse('https://www.allocine.fr/', 'https://fr/');
  });

  it('denies non-http targets and unparseable junk outright', () => {
    expectFalse('https://www.allocine.fr/', 'file:///etc/passwd');
    expectFalse('https://www.allocine.fr/', 'javascript:alert(1)');
    expectFalse('https://www.allocine.fr/', '::garbage::');
  });

  it('custom cinema domains are usable through buildAllowedChildDomains', () => {
    const set = buildAllowedChildDomains([
      'https://www.cinevox-annecy.fr/',
      'https://www.cinemontblanc.fr',
    ]);
    expect(set.has('cinevox-annecy.fr')).toBe(true);
    expect(set.has('cinemontblanc.fr')).toBe(true);
    expectTrue('https://www.cinevox-annecy.fr/', 'https://seances.cinevox-annecy.fr/x', set);
    expectFalse('https://www.cinevox-annecy.fr/', 'https://evil.example/', set);
  });

  it('buildAllowedChildDomains always includes the rating providers and skips invalid urls', () => {
    const set = buildAllowedChildDomains(['::not a url', 'https://']);
    for (const d of RATING_PROVIDER_DOMAINS) expect(set.has(d)).toBe(true);
    expect(set.size).toBe(RATING_PROVIDER_DOMAINS.length);
  });

  it('identical url round-trip (challenge reload) is allowed', () => {
    expectTrue('https://www.imdb.com/list/x', 'https://www.imdb.com/list/x');
  });
});
