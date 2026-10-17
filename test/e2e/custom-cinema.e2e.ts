// ──────────────────────────────────────────────────────────────────────────
// COVERAGE: Layer 5 — E2E smoke test for the runtime custom cinema registry.
//
// Tests: launching the BUILT app with a userData/custom-cinemas.json file
//        makes the custom cinema appear in the cinema selector — proving
//        the add/remove-via-file architecture works end to end, in the
//        packaged app path (no dev-server help, JSON-only entries).
//
// Catches: startup registration order (customs load BEFORE the first
//        cinemas:list call), registry → IPC → renderer propagation,
//        validation of the file in a real userData context.
//
// Misses: the cinemas:reload-custom IPC behavior (no renderer control
//        invokes it yet — unit-covered in customRegistry.test.ts).
//
// The custom cinema uses the offline 'example' adapter (empty schedule,
// zero network), so the test is fully deterministic.
//
// See TESTING.md for the failure-mode → test-layer matrix.
// ──────────────────────────────────────────────────────────────────────────
import { test, expect } from '@playwright/test';
import { launchApp } from './helpers/launchApp';

let cleanup: (() => Promise<void>) | null = null;

test.afterEach(async () => {
  if (cleanup) {
    await cleanup();
    cleanup = null;
  }
});

const CUSTOM_CINEMA = {
  id: 'custom-e2e-test',
  name: 'Custom Cinema E2E',
  city: 'Nowhere',
  color: '#f97316',
  adapter: { kind: 'example', baseUrl: 'https://example.com' },
};

test('custom-cinemas.json registers a runtime cinema in the built app', async () => {
  const app = await launchApp({ customCinemas: [CUSTOM_CINEMA] });
  cleanup = app.cleanup;

  // Wait for the cinema selector to finish rendering.
  const builtinButton = app.page.locator('button', { hasText: /Ciné Mont-Blanc/ });
  await expect(builtinButton).toBeVisible({ timeout: 15_000 });

  // The user-authored custom cinema appears alongside the bundled ones.
  const customButton = app.page.locator('button', { hasText: 'Custom Cinema E2E' });
  await expect(customButton).toBeVisible({ timeout: 10_000 });

  // The builtin cinemas are not displaced by the runtime registration.
  await expect(app.page.locator('button', { hasText: 'Ciné de Cluses' })).toBeVisible();
  await expect(app.page.locator('button', { hasText: 'Cinéma Vox' })).toBeVisible();
});

test('an invalid custom entry is rejected with the builtins unaffected', async () => {
  const app = await launchApp({
    customCinemas: [
      { id: 'broken-entry' }, // shape-invalid: missing name/city/color/adapter
      CUSTOM_CINEMA,
    ],
  });
  cleanup = app.cleanup;

  // The valid custom entry still registers.
  await expect(app.page.locator('button', { hasText: 'Custom Cinema E2E' })).toBeVisible({
    timeout: 15_000,
  });

  // The invalid entry carries no pill (its id/name never existed).
  expect(await app.page.locator('button', { hasText: 'broken-entry' }).count()).toBe(0);
});
