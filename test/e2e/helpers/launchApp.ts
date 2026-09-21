import { _electron as electron, ElectronApplication, Page } from '@playwright/test';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

// ──────────────────────────────────────────────────────────────────────────
// Electron launch helper — starts the built app with a temp userData dir.
//
// Each test gets:
//   - A fresh temp directory for userData (cache.db, logs, etc.)
//   - A real ElectronApplication instance (the main process)
//   - A Page object (the renderer window)
//
// Cleanup is automatic via the returned cleanup() function — call it in
// afterEach() to destroy the app + delete the temp dir.
//
// Requirements:
//   - The app must be built: `npm run build`
//   - The main process entry is at `out/main/index.js` (relative to project root)
// ──────────────────────────────────────────────────────────────────────────

export interface LaunchedApp {
  electronApp: ElectronApplication;
  page: Page;
  cleanup: () => Promise<void>;
  userDataDir: string;
}

/** Resolve the path to the built main process entry. */
function mainEntryPath(): string {
  // From test/e2e/helpers/launchApp.ts → project root is 4 levels up.
  // But Playwright runs from the project root, so `out/main/index.js` is
  // relative to cwd. Use process.cwd() for robustness.
  return path.resolve(process.cwd(), 'out/main/index.js');
}

/** Create a unique temp directory for this test's userData. */
function createTempUserDataDir(): string {
  const tmpDir = path.join(
    os.tmpdir(),
    `arvecinema-e2e-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  fs.mkdirSync(tmpDir, { recursive: true });
  return tmpDir;
}

/** Launch the Electron app with an isolated userData directory.
 *
 *  @param options Optional overrides (e.g. env vars for testing).
 *                 Set `options.replayFixture` to a fixture file path to
 *                 replay recorded network responses instead of hitting
 *                 real servers.
 *  @returns LaunchedApp with the ElectronApplication, first Page, and cleanup. */
export async function launchApp(
  options: {
    env?: Record<string, string>;
    replayFixture?: string;
  } = {},
): Promise<LaunchedApp> {
  const entryPath = mainEntryPath();
  if (!fs.existsSync(entryPath)) {
    throw new Error(`Build output not found at ${entryPath}. Run \`npm run build\` first.`);
  }

  const userDataDir = createTempUserDataDir();

  const electronApp = await electron.launch({
    // args: [mainEntryPath, --user-data-dir=...] — the first arg is the
    // entry point, subsequent args are passed to Electron's CLI.
    args: [
      entryPath,
      `--user-data-dir=${userDataDir}`,
      // Disable GPU rendering — needed in headless/CI environments.
      // The sandbox is disabled because we're not running as root in
      // some CI environments and the sandbox requires special privileges.
      '--no-sandbox',
      '--disable-gpu',
      '--disable-software-rasterizer',
    ],
    cwd: process.cwd(),
    env: {
      // process.env can contain undefined values; filter them out since
      // Playwright's env type requires string values only.
      ...(Object.fromEntries(
        Object.entries(process.env).filter(([, v]) => v !== undefined),
      ) as Record<string, string>),
      ...options.env,
      // Replay mode: if a fixture path is provided, set ARVE_REPLAY so
      // the networkRecorder module intercepts all fetch/browserFetch calls
      // and returns recorded responses instead of hitting real servers.
      ...(options.replayFixture ? { ARVE_REPLAY: options.replayFixture } : {}),
    },
  });

  // Wait for the first (main) window to load.
  const page = await electronApp.firstWindow();

  // Give the renderer a moment to finish initial render.
  // The app shows a "Loading…" state initially, then fetches the cinema
  // list + schedule. We wait for the header to appear.
  await page.waitForSelector('h1', { timeout: 30_000 });

  const cleanup = async () => {
    try {
      await electronApp.close();
    } catch {
      /* ignore — app may have already closed */
    }
    // Clean up the temp dir (best effort — don't fail the test if cleanup fails)
    try {
      fs.rmSync(userDataDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  };

  return { electronApp, page, cleanup, userDataDir };
}
