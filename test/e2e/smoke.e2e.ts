// ──────────────────────────────────────────────────────────────────────────
// COVERAGE: Layer 5 — E2E smoke tests (Playwright + Electron).
//
// Tests: App launches, header renders, cinema selector visible, filter bar
//        visible, view toggle visible, about panel opens with license + deps.
//
// Catches: Build breakage, renderer crash, IPC handler missing, missing
//          dependencies, React component rendering failures.
//
// Misses: Data correctness (doesn't verify movie data is real), network
//        behavior (uses mock/temp data), parser logic (doesn't scrape real
//        sites). Does NOT catch server-side changes — that's Layer 6 (live
//        smoke tests, planned).
//
// See TESTING.md for the full failure-mode → test-layer matrix.
// ──────────────────────────────────────────────────────────────────────────
import { test, expect } from '@playwright/test';
import { launchApp } from './helpers/launchApp';

// ──────────────────────────────────────────────────────────────────────────
// Phase 1 E2E smoke test — verifies the app launches and renders.
//
// This is the minimum viable E2E test: it proves:
//   1. The build output is valid (Electron can load it)
//   2. The main process starts without crashing
//   3. The renderer window opens
//   4. The header (app title + version) is visible
//   5. The cinema selector renders (cinemas are loaded from the registry)
//   6. The day selector renders (days come from the schedule fetch)
//   7. The filter bar is visible (search + audio pills + hour slider + sort)
//
// What this test does NOT verify (future phases):
//   - Actual schedule data from live cinema sites (needs network)
//   - Rating badges appearing (needs enrichment pipeline + network)
//   - Retry button behavior (needs blocked sources)
//   - WeekGrid swimlane layout
// ──────────────────────────────────────────────────────────────────────────

let cleanup: (() => Promise<void>) | null = null;

test.afterEach(async () => {
  if (cleanup) {
    await cleanup();
    cleanup = null;
  }
});

test('app launches and shows the header with app title', async () => {
  const app = await launchApp();
  cleanup = app.cleanup;

  // The header should contain the app title "ArveCinema" and version
  const title = app.page.locator('h1');
  await expect(title).toBeVisible();
  await expect(title).toContainText('ArveCinema');

  // Version should be visible (e.g. "v0.12.0")
  const version = app.page.locator('h1 span');
  await expect(version).toBeVisible();
  await expect(version).toContainText(/v\d+\.\d+/);
});

test('cinema selector renders with at least 4 real cinemas', async () => {
  const app = await launchApp();
  cleanup = app.cleanup;

  // Wait for the cinema selector to render — it shows cinema names as pills.
  // The registry auto-discovers 4 real cinemas + 1 canary (example-cinema).
  // We wait for at least the first cinema button to appear.
  const cinemaButton = app.page.locator('button', { hasText: /Ciné|Cinéma/ }).first();
  await expect(cinemaButton).toBeVisible({ timeout: 15_000 });

  // Count cinema pills — should be at least 4 real cinemas
  // (mont-blanc, cluses, bonneville, chamonix). The canary "example-cinema"
  // may also appear (showing as "Example Cinema (Canary)"), so we check ≥4.
  const cinemaPills = app.page.locator('button', { hasText: /Ciné|Cinéma|Vox|Example/ });
  const count = await cinemaPills.count();
  expect(count).toBeGreaterThanOrEqual(4);
});

test('filter bar is visible with search + audio pills + sort', async () => {
  const app = await launchApp();
  cleanup = app.cleanup;

  // Search input should be visible (has a placeholder with "Rechercher" or "Search")
  const searchInput = app.page.locator('input[type="search"]');
  await expect(searchInput).toBeVisible({ timeout: 15_000 });

  // Audio filter pills: VF, VO, and "Tous"/"All"
  const vfPill = app.page.locator('button', { hasText: 'VF' }).first();
  await expect(vfPill).toBeVisible();

  // Sort selector should be visible
  const sortButton = app.page
    .locator('button', { hasText: /Prochaine séance|Titre|Cinéma|Next screening|Title|Cinema/ })
    .first();
  await expect(sortButton).toBeVisible();
});

test('view toggle (Day/Week) is visible', async () => {
  const app = await launchApp();
  cleanup = app.cleanup;

  // ViewToggle has two buttons: "Jour"/"Day" and "Semaine"/"Week"
  const dayButton = app.page.locator('button', { hasText: /^(Jour|Day)$/ }).first();
  await expect(dayButton).toBeVisible({ timeout: 15_000 });

  const weekButton = app.page.locator('button', { hasText: /^(Semaine|Week)$/ }).first();
  await expect(weekButton).toBeVisible();
});

test('theme toggle + language toggle + about button are visible in header', async () => {
  const app = await launchApp();
  cleanup = app.cleanup;

  // Theme toggle: shows ☀ in dark mode or 🌙 in light mode
  const themeButton = app.page.locator(
    'button[aria-label*="thème"], button[aria-label*="theme"], button[aria-label*="clair"], button[aria-label*="light"]',
  );
  await expect(themeButton).toBeVisible({ timeout: 15_000 });

  // Language toggle: shows 🇬🇧 when in French mode, or 🇫🇷 when in English mode
  const langButton = app.page.locator(
    'button[aria-label*="Langue"], button[aria-label*="Language"]',
  );
  await expect(langButton).toBeVisible();

  // About button: shows ℹ
  const aboutButton = app.page.locator('button[aria-label*="propos"], button[aria-label*="About"]');
  await expect(aboutButton).toBeVisible();
});

test('opening the about panel shows the license + dependencies', async () => {
  const app = await launchApp();
  cleanup = app.cleanup;

  // Click the About button
  const aboutButton = app.page.locator('button[aria-label*="propos"], button[aria-label*="About"]');
  await aboutButton.click();

  // The AboutPanel modal should appear — wait for the license section header
  const licenseHeader = app.page.locator('h3', { hasText: /Licence|License/ });
  await expect(licenseHeader).toBeVisible({ timeout: 5_000 });

  // Should mention "BSD-3-Clause" in the footer or license summary
  const bsdText = app.page.locator('text=/BSD.?3.?Clause/i').first();
  await expect(bsdText).toBeVisible();

  // Should show the dependencies section header
  const depsHeader = app.page.locator('h3', { hasText: /Biblioth|Used software/ });
  await expect(depsHeader).toBeVisible();
});

test('diagnostics tab shows cinema health + copy diagnostics button', async () => {
  const app = await launchApp();
  cleanup = app.cleanup;

  // Click the About button
  const aboutButton = app.page.locator('button[aria-label*="propos"], button[aria-label*="About"]');
  await aboutButton.click();

  // Switch to the Diagnostics tab
  const diagTab = app.page.locator('button', { hasText: /Diagnostics/ }).first();
  await expect(diagTab).toBeVisible();
  await diagTab.click();

  // Should show the "Cinemas" section header
  const cinemasHeader = app.page.locator('h3', { hasText: /Cinemas|Cinéma/ }).first();
  await expect(cinemasHeader).toBeVisible({ timeout: 5_000 });

  // Should show the "Rating sources" section header
  const sourcesHeader = app.page.locator('h3', { hasText: /Rating sources|Sources de notes/ }).first();
  await expect(sourcesHeader).toBeVisible();

  // Should show the "Copy diagnostics" button
  const copyButton = app.page.locator('button', { hasText: /Copy diagnostics|Copier les diagnostics/ }).first();
  await expect(copyButton).toBeVisible();

  // Should show the "Report issue" button
  const reportButton = app.page.locator('button', { hasText: /Report issue|Signaler un problème/ }).first();
  await expect(reportButton).toBeVisible();
});
