#!/bin/bash
# ──────────────────────────────────────────────────────────────────────────
# run-e2e.sh — starts Xvfb (if needed) and runs Playwright E2E tests.
#
# On macOS and Windows, Xvfb isn't needed — the native display works.
# On Linux without a display, we start Xvfb and keep it alive for the
# duration of the test run.
# ──────────────────────────────────────────────────────────────────────────
set -e

# Check if we already have a DISPLAY
if [ -n "$DISPLAY" ]; then
  echo "[e2e] DISPLAY=$DISPLAY — running tests directly"
  npx playwright test "$@"
  exit $?
fi

# On Linux, start Xvfb
if [ "$(uname)" = "Linux" ]; then
  # Kill any stale Xvfb on :99
  pkill -f "Xvfb :99" 2>/dev/null || true
  rm -f /tmp/.X11-unix/X99
  sleep 1

  # Start Xvfb — keep it in the background, kill it on exit
  Xvfb :99 -screen 0 1280x800x24 -nolisten tcp -ac +extension RANDR 2>/dev/null &
  XVFB_PID=$!
  echo "[e2e] Xvfb started on :99 (pid=$XVFB_PID)"

  # Wait for Xvfb to be ready
  sleep 2

  # Verify it's running
  if ! kill -0 $XVFB_PID 2>/dev/null; then
    echo "[e2e] ERROR: Xvfb failed to start"
    exit 1
  fi

  # Trap exit — kill Xvfb when the script exits
  trap "echo '[e2e] Stopping Xvfb (pid=$XVFB_PID)'; kill $XVFB_PID 2>/dev/null; rm -f /tmp/.X11-unix/X99" EXIT

  export DISPLAY=:99
  echo "[e2e] Running tests with DISPLAY=$DISPLAY"
  npx playwright test "$@"
  exit $?
fi

# Fallback: just run the tests
echo "[e2e] No DISPLAY set and not Linux — running tests directly (may fail)"
npx playwright test "$@"
