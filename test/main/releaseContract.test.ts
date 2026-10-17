// ──────────────────────────────────────────────────────────────────────────
// Release engineering contract — pins the release + auto-update plumbing
// together so a refactor can't silently break one side.
//
// Source-audit based (same rationale as loggingContract: main/index.ts and
// electron-updater need the electron runtime and can't be imported here,
// while package.json and the workflow YAML are data anyway).
//
// What this catches:
//   - electron-updater dropped from dependencies (it's a RUNTIME dep)
//   - publish config drifted from the actual GitHub repo (updater would
//     look for releases under the wrong owner/repo)
//   - the updater inited in dev/fixture runs (would hit the release feed
//     during tests / e2e)
//   - the release workflow forgetting one of the 3 required artifacts
//     (.dmg + .blockmap + latest-mac.yml — updater reads the .yml)
//   - auto-install escaping the "scheduled on quit" policy
// ──────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/** Root package.json lives outside tsconfig's include — read as data. */
const packageJson = JSON.parse(read('package.json')) as {
  dependencies: Record<string, string>;
  build: {
    publish: { provider: string; owner: string; repo: string };
    mac: { target: Array<{ target: string; arch: string[] }> };
  };
};

// ── package.json (dependency + builder config) ────────────────────────────

describe('release contract: package.json', () => {
  it('electron-updater is a RUNTIME dependency (bundled in the app)', () => {
    expect(packageJson.dependencies['electron-updater']).toMatch(/^\^?6\./);
  });

  it('build.publish points at the real GitHub repo (updater feed origin)', () => {
    expect(packageJson.build.publish.provider).toBe('github');
    expect(packageJson.build.publish.owner).toBe('SylvainSouche');
    expect(packageJson.build.publish.repo).toBe('arvecinema');
  });

  it('mac target is dmg arm64 (matches the release workflow runner)', () => {
    expect(packageJson.build.mac.target[0].target).toBe('dmg');
    expect(packageJson.build.mac.target[0].arch).toContain('arm64');
  });
});

// ── src/main/updater.ts (activation guards + update policy) ───────────────

describe('release contract: updater module', () => {
  const src = () => read('src/main/updater.ts');

  it('skips dev AND fixture runs (never touches the feed from tests/e2e)', () => {
    const s = src();
    expect(s).toMatch(/!app\.isPackaged \|\| isFixtureRun/);
    expect(s).toMatch(/ARVE_REPLAY === '1' \|\| process\.env\.ARVE_RECORD === '1'/);
  });

  it('policy: auto-download allowed, install happens on quit or by explicit user choice', () => {
    const s = src();
    expect(s).toMatch(/autoDownload = true/);
    expect(s).toMatch(/autoInstallOnAppQuit = true/);
    // quitAndInstall appears exactly once — inside the user-dialog branch
    // (an auto-installer elsewhere would surprise-prompt mid-session).
    expect((s.match(/quitAndInstall/g) ?? []).length).toBe(1);
  });

  it('logs through the updater component logger (LogViewer visible)', () => {
    expect(src()).toMatch(/log\.updater\./);
    expect(read('src/main/ratings/moduleLoggers.ts')).toMatch(/updater: getComponentLogger\('updater'\)/);
  });

  it('status machine is queryable (for a future About-panel badge)', () => {
    expect(src()).toMatch(/export function getUpdateStatus\(\)/);
  });
});

// ── src/main/index.ts (wiring) ────────────────────────────────────────────

describe('release contract: updater wiring in main', () => {
  it('maybeInitAutoUpdater imported and called in app.whenReady', () => {
    const s = read('src/main/index.ts');
    expect(s).toMatch(/import \{ maybeInitAutoUpdater \} from '\.\/updater'/);
    expect(s).toMatch(/maybeInitAutoUpdater\(\);/);
  });

  it('no renderer/preload update plumbing exists (dialog-only, by design)', () => {
    const preload = read('src/preload/index.ts');
    expect(preload).not.toMatch(/update[:\-]/i);
  });
});

// ── .github/workflows/release.yml ─────────────────────────────────────────

describe('release contract: release workflow', () => {
  it('exists and triggers on v* tags + manual dispatch', () => {
    const yml = read('.github/workflows/release.yml');
    expect(yml).toMatch(/tags:\s*\n\s*-\s*'v\*'/);
    expect(yml).toMatch(/workflow_dispatch/);
    expect(yml).toMatch(/permissions:\s*\n\s*contents: write/);
  });

  it('rebuilds better-sqlite3 for Electron ABI before packaging (recurring trap)', () => {
    expect(read('.github/workflows/release.yml')).toMatch(/electron-rebuild -f -w better-sqlite3/);
  });

  it('uploads ALL THREE updater artifacts (.dmg, .blockmap, latest-mac.yml)', () => {
    const yml = read('.github/workflows/release.yml');
    expect(yml).toMatch(/dist\/\*\.dmg/);
    expect(yml).toMatch(/dist\/\*\.blockmap/);
    expect(yml).toMatch(/dist\/latest-mac\.yml/);
  });

  it('passes GH_TOKEN to electron-builder (activates the publish step)', () => {
    const yml = read('.github/workflows/release.yml');
    expect(yml).toMatch(/GH_TOKEN: \$\{\{ secrets\.GITHUB_TOKEN \}\}/);
  });

  it('runs on a mac arm64 runner (native to the target arch)', () => {
    expect(read('.github/workflows/release.yml')).toMatch(/runs-on: macos/);
  });
});
