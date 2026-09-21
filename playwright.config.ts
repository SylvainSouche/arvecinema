import { defineConfig } from '@playwright/test';

// ──────────────────────────────────────────────────────────────────────────
// Playwright config — E2E tests for the Electron app.
//
// Tests live in `test/e2e/` and use Playwright's `_electron` module to
// launch the built app (from `out/main/index.js`) with a temp userData
// directory.
//
// Requirements:
//   - The app must be built first: `npm run build`
//   - Tests assume the build output is at `out/main/index.js`
//
// To run:
//   npm run test:e2e
//
// To run with a visible window (for debugging):
//   npx playwright test --headed
// ──────────────────────────────────────────────────────────────────────────

export default defineConfig({
  testDir: './test/e2e',
  testMatch: '*.e2e.ts',

  // Each test gets its own Electron instance — no parallelism (Electron
  // doesn't play well with concurrent instances in CI).
  fullyParallel: false,
  workers: 1,

  // Timeout per test — Electron startup is slow (~10s on CI).
  timeout: 60_000,
  expect: {
    timeout: 10_000,
  },

  // Reporter — concise in terminal, HTML for debugging.
  reporter: process.env.CI ? 'github' : 'list',

  use: {
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },

  // No webServer config — we launch Electron directly, not a web page.
});
