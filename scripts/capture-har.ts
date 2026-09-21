// ──────────────────────────────────────────────────────────────────────────
// Network capture script — launches the app and records ALL network traffic.
//
// Usage:
//   npm run capture:har
//
// Output:
//   `<download-dir>/arvecinema-netlog.json` — Chromium net log (JSON)
//
// IMPORTANT: Playwright's `recordHar` only captures renderer-side traffic.
// Our fetches happen in the MAIN PROCESS (fetchWithTimeout, browserFetch),
// so recordHar produces an empty file. We use Electron's `--log-net-log`
// flag instead, which captures ALL network traffic at the Chromium level
// — including main-process fetch, hidden BrowserWindow fetch, and any
// renderer-side requests.
//
// The output is Chromium net log format (JSON), not standard HAR. It can
// be viewed in Chrome's chrome://net-export/ viewer or converted to HAR
// via tools like netlog2har.
// ──────────────────────────────────────────────────────────────────────────

import { _electron as electron } from '@playwright/test';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

function resolveOutputPath(filename: string): string {
  let projectRoot = process.cwd();
  while (projectRoot !== '/' && !fs.existsSync(path.join(projectRoot, 'package.json'))) {
    projectRoot = path.dirname(projectRoot);
  }

  const candidates = [
    path.resolve(projectRoot, '..', 'download'),
    path.resolve(projectRoot, 'download'),
    path.resolve(process.cwd(), 'download'),
    process.cwd(),
  ];

  for (const dir of candidates) {
    if (fs.existsSync(dir)) {
      return path.join(dir, filename);
    }
  }
  return path.resolve(process.cwd(), filename);
}

const NETLOG_PATH = resolveOutputPath('arvecinema-netlog.json');
const APP_ENTRY = path.resolve(process.cwd(), 'out/main/index.js');

async function main() {
  if (!fs.existsSync(APP_ENTRY)) {
    console.error('Build output not found. Run `npm run build` first.');
    process.exit(1);
  }

  const userDataDir = path.join(os.tmpdir(), `arvecinema-capture-${Date.now()}`);
  fs.mkdirSync(userDataDir, { recursive: true });

  console.log('Launching app for network capture...');
  console.log(`  Entry:      ${APP_ENTRY}`);
  console.log(`  userData:   ${userDataDir}`);
  console.log(`  Net log:    ${NETLOG_PATH}`);
  console.log('');
  console.log('The app will open and fetch schedules automatically.');
  console.log('You can also:');
  console.log('  - Click refresh (↻) to re-fetch schedules');
  console.log('  - Click retry (⚡) to capture blocked-source retries');
  console.log('  - Open About → Diagnostics to see what was captured');
  console.log('');
  console.log('Press Ctrl+C when done. The net log will be saved automatically.');
  console.log('');

  const app = await electron.launch({
    args: [
      APP_ENTRY,
      `--user-data-dir=${userDataDir}`,
      '--no-sandbox',
      '--disable-gpu',
      `--log-net-log=${NETLOG_PATH}`,
    ],
    cwd: process.cwd(),
    env: {
      ...Object.fromEntries(
        Object.entries(process.env).filter(([, v]) => v !== undefined),
      ) as Record<string, string>,
    },
  });

  const page = await app.firstWindow();
  console.log('App window opened. Waiting for you to interact...');
  console.log('(Press Ctrl+C when done)');

  await new Promise<void>((resolve) => {
    app.on('close', () => resolve());
    process.on('SIGINT', () => {
      console.log('\nStopping app and saving net log...');
      void app.close().then(() => resolve());
    });
  });

  // Give Chromium a moment to flush the net log to disk
  await new Promise((r) => setTimeout(r, 500));

  if (fs.existsSync(NETLOG_PATH)) {
    const sizeMB = (fs.statSync(NETLOG_PATH).size / 1024 / 1024).toFixed(2);
    console.log(`\nNet log saved: ${NETLOG_PATH}`);
    console.log(`File size: ${sizeMB} MB`);
    console.log('');
    console.log('To view: open the file in Chrome at chrome://net-export/');
    console.log('Or send it to the developer for conversion to HAR + fixture tests.');
  } else {
    console.log('\nNet log file was not created. Check the app logs for errors.');
  }

  try {
    fs.rmSync(userDataDir, { recursive: true, force: true });
  } catch { /* ignore */ }
}

main().catch((err) => {
  console.error('Capture failed:', err);
  process.exit(1);
});
