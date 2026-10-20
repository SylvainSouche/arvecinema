// ──────────────────────────────────────────────────────────────────────────
// cinema-monitor-issue tests — the notification state machine's pure core.
// The gh-CLI calls are ops glue (workflow steps run them for real); what is
// unit-tested: fingerprinting (unchanged failures = silence), delta
// computation, empty-schedule streak persistence, issue-body building.
// ──────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from 'vitest';
import {
  buildFingerprint,
  diffFailureIds,
  updateEmptyStreaks,
  buildIssueBody,
} from '../../scripts/cinema-monitor-issue.mjs';
import type { MonitorRow } from '../../scripts/cinema-monitor-issue.mjs';

const row: (id: string, state: MonitorRow['state'], detail?: string, movies?: number) => MonitorRow = (
  id,
  state,
  detail = 'x',
  movies = 5,
) => ({
  id,
  group: 'cinemas',
  url: `https://t/${id}`,
  method: 'GET',
  state,
  status: 200,
  ms: 1234,
  verdict: state === 'broken' ? 'blocked' : 'ok',
  detail,
  stats:
    state === 'unknown'
      ? { movies, days: 0, showtimes: 0, malformed: 0 }
      : undefined,
});

describe('buildFingerprint (change detection)', () => {
  it('stable across ordering and healthy-stat drift', () => {
    const a = buildFingerprint([row('a', 'broken', '503'), row('b', 'healthy'), row('c', 'broken', '404')]);
    const b = buildFingerprint([row('c', 'broken', '404'), row('z', 'healthy', 'irrelevant detail'), row('a', 'broken', '503')]);
    expect(a).toBe(b);
  });

  it('different failure detail or state = different fingerprint (a real change)', () => {
    const a = buildFingerprint([row('a', 'broken', 'timeout')]);
    const b = buildFingerprint([row('a', 'broken', '503')]);
    const c = buildFingerprint([row('a', 'degraded', 'timeout')]);
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
  });

  it('healthy + unknown-only states fingerprint to empty (no issue', () => {
    expect(buildFingerprint([row('a', 'healthy'), row('b', 'unknown', 'empty', 0)])).toBe('');
  });
});

describe('diffFailureIds', () => {
  it('report new and resolved failures by id', () => {
    const prev = [row('a', 'broken'), row('b', 'broken')];
    const next = [row('b', 'broken'), row('c', 'broken'), row('a', 'healthy')];
    expect(diffFailureIds(prev, next)).toEqual({
      newFailures: ['c'],
      resolved: ['a'],
    });
  });
});

describe('updateEmptyStreaks (streak persistence in the issue body)', () => {
  it('starts at 1 for a first-seen empty cinema', () => {
    const streaks = updateEmptyStreaks('', [row('cinema:x', 'unknown', 'empty', 0)], '2026-10-20');
    expect(streaks).toEqual([{ id: 'cinema:x', weeks: 1, since: '2026-10-20', fresh: true }]);
  });

  it('increments the stored streak between runs (different weeks)', () => {
    const prevBody = '<!-- empty-streak: cinema:x=2,2026-10-06 -->';
    const streaks = updateEmptyStreaks(prevBody, [row('cinema:x', 'unknown', 'empty', 0)], '2026-10-20');
    expect(streaks).toEqual([{ id: 'cinema:x', weeks: 3, since: '2026-10-06', fresh: false }]);
  });

  it('a cinema with screenings resets (leaves) the streak', () => {
    const prevBody = '<!-- empty-streak: cinema:x=2,2026-10-06 -->';
    const streaks = updateEmptyStreaks(
      prevBody,
      [row('cinema:x', 'unknown', 'empty', 0), row('cinema:y', 'broken', 'x')],
      '2026-10-20',
    );
    expect(streaks.map((s) => s.id)).toEqual(['cinema:x']); // broken≠unknown; y not in streaks
  });
});

describe('buildIssueBody', () => {
  const res = [
    row('cinema:a', 'broken', 'HTTP 410 — endpoint moved/removed?'),
    row('cinema:b', 'healthy'),
    row('cinema:c', 'unknown', 'valid shape but EMPTY schedule', 0),
  ];

  it('marks non-editability, embeds run info, fails only rows, and persists streaks', () => {
    const prevBody = '<!-- empty-streak: cinema:c=4,2026-09-22 -->\nold table';
    const body = buildIssueBody({ results: res }, prevBody, '2026-10-20');
    expect(body).toContain('auto-generated');
    expect(body).toContain('2026-10-20');
    expect(body).toContain('`cinema:a`'); // fails table row present
    expect(body).not.toContain('`cinema:b`'); // healthy not in the fails table
    expect(body).toContain('empty schedule for 5 consecutive run(s)'); // 4+1
    expect(body).toMatch(/<!-- monitor-fingerprint: \S+ -->/);
    expect(body).toContain('<!-- empty-streak: cinema:c=5,2026-09-22 -->'); // persistence marker
  });

  it('fingerprint round-trip: the body marker decodes to the EXACT computed fingerprint (change detection contract)', () => {
    // Live regression caught on 2026-10-20: the marker once held a timestamp
    // while main() compared the computed fingerprint → "changed" every run.
    const body = buildIssueBody({ results: res }, '', '2026-10-20');
    const persisted = body.match(/<!-- monitor-fingerprint: (\S+) -->/)?.[1]!;
    const decoded = Buffer.from(persisted, 'base64').toString('utf8');
    expect(decoded).toBe(buildFingerprint(res));
    // Two consecutive reports of the SAME failure set carry the SAME marker
    // (the no-spam guarantee), even though "Last run" timestamps differ.
    const body2 = buildIssueBody({ results: res }, body, '2026-10-27');
    expect(body2.match(/<!-- monitor-fingerprint: (\S+) -->/)?.[1]).toBe(persisted);
  });

  it('all-healthy body states "none" (and stays famous-simple)', () => {
    const body = buildIssueBody({ results: [row('cinema:a', 'healthy'), row('cinema:b', 'healthy', 'x')] }, '', 'today');
    expect(body).toContain('_none — all sources healthy');
    expect(body).toContain('_none_');
  });
});
