import { defineConfig } from 'vitest/config';

// ──────────────────────────────────────────────────────────────────────────
// Vitest configuration — runs unit tests for pure functions in src/shared/
// and src/main/ratings/. Tests live in `test/` next to `src/`.
//
// Why vitest?
//   - Native TypeScript support (no separate compile step)
//   - Same Vite transform as the app (so test imports resolve identically)
//   - Fast watch mode + built-in coverage
//   - Compatible with Jest's `expect()` API
//
// What we DON'T test here:
//   - Electron-dependent code (cinema adapters using `electron.BrowserWindow`,
//     cacheDb using `app.getPath('userData')`) — these need mocking or
//     integration tests. We mock the few electron calls we need.
//   - React component rendering — would need @testing-library/react. Add
//     later if visual regression becomes a concern.
// ──────────────────────────────────────────────────────────────────────────

export default defineConfig({
  test: {
    // Look for *.test.ts files under test/
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
    // Exclude node_modules + build artifacts
    exclude: ['node_modules/**', 'dist/**', 'out/**', 'build/**'],
    // Use the node environment (we test pure TS, not DOM)
    environment: 'node',
    // Enable global APIs (describe, it, expect) without imports
    globals: true,
    // Run setup file before each test file
    setupFiles: ['./test/setup.ts'],
    // Force the timezone to Europe/Paris — affects how `new Date()` interprets
    // no-tz-designator ISO strings (matching production behavior).
    env: {
      TZ: 'Europe/Paris',
    },
    // Coverage configuration — opt-in via `npm run test:coverage`
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/shared/**/*.ts', 'src/main/ratings/cacheDb.ts'],
      exclude: ['src/**/*.d.ts', 'src/**/*.test.ts'],
    },
  },
});
