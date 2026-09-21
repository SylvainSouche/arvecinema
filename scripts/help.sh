#!/bin/bash
# ──────────────────────────────────────────────────────────────────────────
# ArveCinema — available npm commands
# ──────────────────────────────────────────────────────────────────────────
cat << 'TEXT'
ArveCinema v0.12.7

DEVELOPMENT
  npm run dev              Launch app in dev mode (hot reload)
  npm run debug            Same + ARVE_DEBUG=1 (verbose logs, DevTools)
  npm run build            Compile to out/ (main + preload + renderer)
  npm run preview          Run built app from out/ without rebuilding

CODE QUALITY
  npm run typecheck        TypeScript type check (no build)
  npm run format           Format all source files with Prettier
  npm run format:check     Verify formatting without writing

UNIT TESTS (vitest, ~1.9s, 212 tests)
  npm run test             Run all unit tests once
  npm run test:watch       Re-run tests on file change
  npm run test:coverage    Run tests + coverage report

E2E TESTS (Playwright + Electron, ~60s)
  npm run test:e2e         Launch real app, run smoke tests
  npm run test:e2e:headed  Same but show the app window

NETWORK RECORD/REPLAY
  npm run record           Launch app, capture all HTTP traffic to
                           test/fixtures/network-capture.json
                           (close the app to save the fixture)
  npm run replay           Run E2E tests using the recorded fixture
                           (no network needed, fully deterministic)

PACKAGING
  npm run package          Build + package for current platform
  npm run package:dir      Build + unpacked dir (faster, for testing)
  npm run package:dmg       Build + macOS .dmg only
TEXT
