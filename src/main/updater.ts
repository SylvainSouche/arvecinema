// ──────────────────────────────────────────────────────────────────────────
// Auto-update wiring (electron-updater + GitHub Releases).
//
// Feed: GitHub Releases for fr.arvecinema.app — the `publish` config in
// package.json's build section points electron-builder at GitHub, so every
// tagged release (.github/workflows/release.yml) uploads a .dmg plus the
// latest-mac.yml metadata electron-updater reads.
//
// Activation gates (checked in maybeInitAutoUpdater):
//   - app.isPackaged      → never in dev (electron-vite dev / test runs)
//   - ARVE_REPLAY/ARVE_RECORD unset → never during e2e fixture runs, even
//     if someone runs the packaged app
//
// macOS caveat (honest note): applying updates on macOS requires a SIGNED
// build (Developer ID + notarization). Until that is set up (TODO: release
// engineering), the updater can detect and NOTIFY about newer releases but
// the install step will fail the signature check — that failure is logged,
// never crashes the app. It becomes fully functional the moment the app
// ships signed, with zero further code changes.
//
// Scope kept deliberately tiny: notifications go through native dialogs —
// no preload/renderer plumbing. If the user dismisses, the check re-arms
// on the next launch (checkForUpdates on every startup, no auto-install).
// ──────────────────────────────────────────────────────────────────────────

import { autoUpdater } from 'electron-updater';
import { app, dialog } from 'electron';
import { log } from './ratings/moduleLoggers';

/** Update state the (future) About panel can query. */
export type UpdateStatus = 'idle' | 'checking' | 'available' | 'not-available' | 'downloaded' | 'error';

let status: UpdateStatus = 'idle';

export function getUpdateStatus(): UpdateStatus {
  return status;
}

/**
 * Start the auto-update checker. Safe to call unconditionally — every
 * guard lives inside. Returns true if the updater actually initialized.
 */
export function maybeInitAutoUpdater(): boolean {
  // Test/e2e fixture runs must never touch the update feed (and the
  // updater only makes sense for packaged builds anyway).
  const isFixtureRun = process.env.ARVE_REPLAY === '1' || process.env.ARVE_RECORD === '1';
  if (!app.isPackaged || isFixtureRun) {
    log.updater.debug('[updater] skipped (dev/fixture build)');
    return false;
  }

  status = 'checking';
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true; // scheduled updates land on next quit
  autoUpdater.logger = {
    info: (m: unknown) => log.updater.info(`[updater] ${String(m)}`),
    warn: (m: unknown) => log.updater.warn(`[updater] ${String(m)}`),
    error: (m: unknown) => log.updater.error(`[updater] ${String(m)}`),
    debug: (m: unknown) => log.updater.debug(`[updater] ${String(m)}`),
  };

  autoUpdater.on('checking-for-update', () => (status = 'checking'));
  autoUpdater.on('update-available', (info) => {
    status = 'available';
    log.updater.info(`[updater] update available: ${String(info?.version ?? '?')}`);
  });
  autoUpdater.on('update-not-available', () => (status = 'not-available'));
  autoUpdater.on('update-downloaded', async (info) => {
    status = 'downloaded';
    // Native dialog — deliberately no renderer/preload plumbing.
    try {
      await dialog.showMessageBox({
        type: 'info',
        title: 'ArveCinema',
        message: `Une mise à jour ${String(info?.version ?? '')} est prête.`,
        detail: 'Elle sera installée au prochain redémarrage de l’application, ou maintenant si vous préférez.',
        buttons: ['Redémarrer maintenant', 'Au prochain redémarrage'],
        defaultId: 0,
      }).then(({ response }) => {
        if (response === 0) autoUpdater.quitAndInstall();
      });
    } catch (err) {
      log.updater.warn(`[updater] dialog failed: ${String(err)}`);
    }
  });
  autoUpdater.on('error', (err) => {
    status = 'error';
    // Unsigned-macOS update attempts land here until notarization exists —
    // informative, never fatal.
    log.updater.warn(`[updater] error: ${err?.message ?? String(err)}`);
  });

  const check = (): void => {
    autoUpdater.checkForUpdates().catch((err: Error) => {
      // Network offline etc. — one log line, no crash.
      log.updater.warn(`[updater] check failed: ${err.message}`);
    });
  };

  // Check after launch (give the window time to settle) and re-check daily.
  setTimeout(check, 15_000);
  const DAY_MS = 24 * 60 * 60 * 1000;
  const timer = setInterval(() => {
    if (!app.isPackaged) {
      clearInterval(timer);
      return;
    }
    check();
  }, DAY_MS);
  timer.unref?.();

  log.updater.info('[updater] initialized (GitHub Releases feed)');
  return true;
}
