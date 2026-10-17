// One-off helper: headless network recording for the replay fixture.
// Launches the built app with ARVE_RECORD, waits for schedule + ratings
// enrichment to settle, closes cleanly so shutdown saves the fixture.
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { _electron } = require('@playwright/test');

const ROOT = path.join(__dirname, '..');
const FIXTURE = path.join(ROOT, 'test', 'fixtures', 'network-capture.json');

(async () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'arvecinema-record-'));
  console.log('fixture target:', FIXTURE);

  const app = await _electron.launch({
    args: [
      path.join(ROOT, 'out', 'main', 'index.js'),
      `--user-data-dir=${userData}`,
      '--no-sandbox',
      '--disable-gpu',
      '--disable-software-rasterizer',
    ],
    env: { ...process.env, ARVE_RECORD: FIXTURE },
  });

  // Pipe the app's own stdout/stderr so shutdown-side messages
  // ([shutdown], [network-recorder]) are visible in this script's log.
  app.process().stdout.on('data', (d) => process.stdout.write('[app] ' + d));
  app.process().stderr.on('data', (d) => process.stderr.write('[app] ' + d));

  const page = await app.firstWindow();
  await page.waitForSelector('h1', { timeout: 60_000 });
  console.log('window up — waiting 40s for schedule + enrichment cycle…');
  await page.waitForTimeout(40_000);

  // Open the About panel briefly? Not needed — background runs on startup.

  // Trigger Electron's real quit path (before-quit → doShutdown →
  // Step 5 saves the fixture). Note: the shutdown coordinator ends in
  // process.exit(0), which tears down the CDP connection — the evaluate
  // call usually rejects (or the process just dies). That is expected;
  // the fixture is on disk by then. Only the outer catch runs after failure.
  try {
    await app.evaluate(({ app: electronApp }) => electronApp.quit());
  } catch {
    /* process exited into process.exit(0) — expected */
  }
  // The shutdown coordinator ends in process.exit(0) — wait for the deed.
  await new Promise((resolve) => {
    app.process().once('exit', resolve);
    setTimeout(resolve, 10_000);
  });
  if (fs.existsSync(FIXTURE)) {
    const size = fs.statSync(FIXTURE).size;
    console.log('fixture size:', (size / 1024 / 1024).toFixed(2), 'MB');
  }
  fs.rmSync(userData, { recursive: true, force: true });
})().catch((err) => {
  console.error('record failed:', err);
  process.exit(1);
});
