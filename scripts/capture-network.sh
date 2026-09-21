#!/bin/bash
# ──────────────────────────────────────────────────────────────────────────
# Network capture — launches the app with ARVE_RECORD to capture ALL
# HTTP traffic (fetchWithTimeout + browserFetch) to a JSON fixture.
#
# Usage:
#   npm run record
#
# Output:
#   test/fixtures/network-capture.json — replayable fixture file
#
# Then run the E2E tests with replay:
#   npm run replay
# ──────────────────────────────────────────────────────────────────────────
set -e

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FIXTURE="$PROJECT_ROOT/test/fixtures/network-capture.json"

echo "[capture] Building app..."
cd "$PROJECT_ROOT"
npm run build 2>/dev/null

echo "[capture] Launching app with network recording..."
echo "[capture] Fixture will be saved to: $FIXTURE"
echo "[capture] The app will open. Let it fetch schedules, then close it."
echo "[capture] Press Ctrl+C or close the app window when done."
echo ""

# Launch the app with ARVE_RECORD set — the networkRecorder module
# intercepts all fetchWithTimeout + browserFetch calls and saves
# responses to the fixture file on shutdown.
ARVE_RECORD="$FIXTURE" \
  npx electron \
  --no-sandbox \
  --disable-gpu \
  out/main/index.js \
  --user-data-dir=/tmp/arvecinema-capture-$$

echo ""
if [ -f "$FIXTURE" ]; then
  SIZE=$(du -h "$FIXTURE" | cut -f1)
  ENTRIES=$(python3 -c "import json; print(len(json.load(open('$FIXTURE'))))" 2>/dev/null || echo "?")
  echo "[capture] ✓ Fixture saved: $FIXTURE ($SIZE, $ENTRIES entries)"
  echo ""
  echo "[capture] To replay in E2E tests:"
  echo "  npm run replay"
else
  echo "[capture] ✗ Fixture was not created. Check the app logs."
  exit 1
fi
