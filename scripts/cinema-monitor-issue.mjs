#!/usr/bin/env node
// ──────────────────────────────────────────────────────────────────────────
// cinema-monitor-issue — turns scrape-probe reports into ACTIONABLE state:
// a single tracking GitHub issue that is only touched when the failure
// state CHANGES (review's "notify only on state changes or sustained
// failure, rather than opening a new issue every time").
//
// Called from .github/workflows/nonregression.yml after every probe run
// (weekly + manual dispatch). All persistence lives in the issue body
// (fingerprint + empty-schedule streak counters in HTML comments) — no
// workspace state survives between runs, which is by design.
//
// Behavior:
//   failures + no issue        → create the tracking issue
//   failures + issue unchanged → do nothing (silent, already tracked)
//   failures + issue + CHANGED set → update issue body + comment the delta
//   no failures + open issue   → comment "resolved" and close
//
// Failing the workflow stays the primary signal (red run); the issue is
// the notification/diagnosis layer on top.
// ──────────────────────────────────────────────────────────────────────────

import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

/** Stable identity of the current failure set: sorted "id|state|reason" —
 *  the same failures in a different order, or healthy stats ticking, do
 *  NOT count as a change. */
export function buildFingerprint(results) {
  const failures = results
    .filter((r) => r.state === 'broken' || r.state === 'degraded')
    .map((r) => `${r.id}|${r.state}|${r.detail}`)
    .sort();
  return failures.join('\n');
}

/** Which failure ids are new / resolved between two failure sets. */
export function diffFailureIds(prevResults, nextResults) {
  const failing = (rs) => new Set(rs.filter((r) => r.state === 'broken' || r.state === 'degraded').map((r) => r.id));
  const prev = failing(prevResults);
  const next = failing(nextResults);
  return {
    newFailures: [...next].filter((id) => !prev.has(id)),
    resolved: [...prev].filter((id) => !next.has(id)),
  };
}

/** Empty-schedule streak persistence: `<!-- empty-streak: id=N,weeks=D -->`
 *  comments stored in the issue body. Report rows use stats.movies===0. */
export function updateEmptyStreaks(prevBody, results, today) {
  const empty = results.filter((r) => r.state === 'unknown' && r.stats && r.stats.movies === 0);
  const markers = new Map();
  for (const m of (prevBody ?? '').matchAll(/<!-- empty-streak: ([^=]+)=([\d]+),([^\s>]+) -->/g)) {
    markers.set(m[1], { weeks: Number(m[2]), since: m[3] });
  }
  const out = [];
  for (const r of empty) {
    const prev = markers.get(r.id);
    out.push({
      id: r.id,
      weeks: (prev?.weeks ?? 0) + 1,
      since: prev?.since ?? today,
      fresh: prev?.weeks === undefined,
    });
  }
  return out;
}

function markdownTable(results) {
  const rows = results.map(
    (r) =>
      `| \`${r.id}\` | ${r.status ?? '—'} | ${r.state} | ${r.verdict} | ${Math.round((r.ms ?? 0) / 100) / 10 + 's'} | ${r.detail} |`,
  );
  return '| TARGET | HTTP | STATE | VERDICT | TIME | DETAIL |\n|---|---|---|---|---|---|\n' + rows.join('\n');
}

export function buildIssueBody(report, prevBody, today) {
  const { results } = report;
  const failures = results.filter((r) => r.state === 'broken' || r.state === 'degraded');
  const emptyStreaks = updateEmptyStreaks(prevBody, results, today);
  const emptyLines = emptyStreaks
    .map(
      (s) =>
        `<!-- empty-streak: ${s.id}=${s.weeks},${s.since} -->\n` +
        `- **\`${s.id}\`** — empty schedule for ${s.weeks} consecutive run(s) (since ${s.since})${s.weeks >= 3 ? ' ⚠️ sustained — may be a real loss of programming' : ''}`,
    )
    .join('\n');

  return [
    'Live scraping non-regression report (auto-generated — do not edit; state is tracked in the HTML comments below).',
    '',
    `Last run: ${today} · probe job: ${process.env.GITHUB_SERVER_URL ?? ''}/${process.env.GITHUB_REPOSITORY ?? ''}/actions/runs/${process.env.GITHUB_RUN_ID ?? '?'}`,
    '',
    '## Current failures',
    failures.length === 0
      ? '_none — all sources healthy (or unknown/empty)_'
      : markdownTable(failures),
    '',
    '## Empty schedules (tracked streak)',
    emptyLines || '_none_',
    '',
    `<!-- monitor-fingerprint: ${Date.now() % 1_000_000_000} -->`,
  ].join('\n');
}

function gh(args, opts = {}) {
  return execFileSync('gh', args, {
    encoding: 'utf8',
    env: { ...process.env },
    ...opts,
  });
}

function findTrackingIssue() {
  try {
    const out = gh(['issue', 'list', '--label', 'cinema-source-monitor', '--state', 'open', '--json', 'number,body']);
    const issues = JSON.parse(out);
    return issues[0] ?? null;
  } catch (err) {
    console.error(`[monitor-issue] gh issue list failed: ${err?.message ?? err}`);
    return null;
  }
}

function main() {
  const reportPath = process.argv[2] ?? 'probe-report.json';
  if (!fs.existsSync(reportPath)) {
    console.error(`[monitor-issue] no report at ${reportPath} — probe never ran?`);
    process.exit(0); // notification layer must not mask the real red run
  }
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  const today = report.runAt ?? new Date().toISOString();
  const fingerprint = buildFingerprint(report.results);

  const issue = findTrackingIssue();
  const ghRepo = gh(['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner']).trim();
  console.log(`[monitor-issue] repo=${ghRepo} existing tracking issue: ${issue ? `#${issue.number}` : 'none'}`);

  // Ensure the label exists (best-effort; needs admin once, usually pre-made).
  try {
    gh(['label', 'create', 'cinema-source-monitor', '--description', 'Live scraping source failures', '--color', 'D93F0B']);
  } catch {
    /* label exists or insufficient perms — fine */
  }

  if (fingerprint === '') {
    if (issue) {
      console.log('[monitor-issue] all sources healthy → closing tracking issue');
      gh(['issue', 'close', String(issue.number), '--comment', `✅ All scraping sources healthy again (run ${today}).`]);
    }
    return;
  }

  if (!issue) {
    const body = buildIssueBody(report, '', today);
    console.log('[monitor-issue] creating tracking issue for the first failure set');
    const url = gh(['issue', 'create', '--title', `[monitor] Scraping source regression (${report.results.filter((r) => r.state === 'broken' || r.state === 'degraded').length} source/s)`, '--body', body, '--label', 'cinema-source-monitor']);
    console.log(`[monitor-issue] created: ${url.trim()}`);
    return;
  }

  // Change detection: compare failure-set fingerprints carried in the body.
  const prevFingerprint = (issue.body ?? '').match(/<!-- monitor-fingerprint: (.+?) -->/)?.[1];
  if (prevFingerprint === fingerprint) {
    console.log('[monitor-issue] failure set UNCHANGED - issue left untouched (no spam)');
    return;
  }
  // Target ids currently listed in the issue's failures table (the previous
  // failure set, persisted as the body table).
  const prevIds = [...(issue.body ?? '').matchAll(/\| `([a-z:=.-]+)` \|/g)].map((m) => m[1]);
  const newlyBroken = report.results
    .filter((r) => r.state === 'broken' || r.state === 'degraded')
    .map((r) => r.id)
    .filter((id) => !prevIds.includes(id));
  const resolved = prevIds.filter((id) => {
    const now = report.results.find((r) => r.id === id);
    return now && now.state !== 'broken' && now.state !== 'degraded';
  });

  const body = buildIssueBody(report, issue.body ?? '', today);
  gh(['issue', 'edit', String(issue.number), '--body', body]);
  const delta = [
    newlyBroken.length ? `🔴 new: ${newlyBroken.map((i) => `\`${i}\``).join(', ')}` : null,
    resolved.length ? `✅ resolved: ${resolved.map((i) => `\`${i}\``).join(', ')}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
  gh(['issue', 'comment', String(issue.number), '--body', `State changed (${today}): ${delta || 'detail drifted'}`]);
  console.log(`[monitor-issue] issue #${issue.number} updated (${delta || 'detail drift'})`);
}

// CLI guard (vitest imports the pure functions).
const isCli = process.argv[1] && process.argv[1].endsWith('cinema-monitor-issue.mjs');
if (isCli) main();
