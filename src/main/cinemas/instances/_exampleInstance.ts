// ──────────────────────────────────────────────────────────────────────────
// Example / canary cinema instance — proves instance auto-discovery works.
//
// This file is intentionally minimal. It exists to verify that ANY .ts file
// dropped into `src/main/cinemas/instances/` (with a default export matching
// the CinemaInstance shape) is automatically picked up by the registry —
// WITHOUT requiring any edit to `registry.ts` or `cinemas.config.json`.
//
// The test in `test/main/cinemas/adapters/plugin.test.ts` (look for the
// "TRUE drop-in cinema instance auto-discovery" describe block) asserts
// that this instance is discoverable. If auto-discovery ever breaks, that
// test fails.
//
// You can also use this file as a copy-paste template when adding a real
// new cinema — just rename the file, change the id/name/city/color/adapter,
// and delete this comment block.
// ──────────────────────────────────────────────────────────────────────────

import type { CinemaInstance } from '../adapters/plugin';

const cinema: CinemaInstance = {
  id: 'example-cinema',
  name: 'Example Cinema (Canary)',
  city: 'Nowhere',
  color: '#9ca3af',
  adapter: {
    kind: 'example',
    baseUrl: 'https://example.com',
  },
};

export default cinema;
