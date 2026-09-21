// ──────────────────────────────────────────────────────────────────────────
// Example / canary plugin — proves the auto-discovery system works.
//
// This file is intentionally minimal. It exists to verify that ANY .ts file
// dropped into `src/main/cinemas/adapters/` (with a default export matching
// the CinemaAdapterPlugin shape) is automatically picked up by the registry
// — WITHOUT requiring any edit to `index.ts`.
//
// The test in `test/main/cinemas/adapters/plugin.test.ts` (look for the
// "TRUE drop-in auto-discovery" describe block) asserts that this plugin
// is discoverable. If someone ever breaks the glob import, that test fails.
//
// You can also use this file as a copy-paste template when writing a real
// new adapter — just rename the file, change the `id`, and implement
// `createAdapter`.
// ──────────────────────────────────────────────────────────────────────────

import type { CinemaAdapter } from '../types';
import type { CinemaAdapterPlugin, CinemaConfig, ConfigValidationResult } from './plugin';
import { requireString, mergeDefaults } from './plugin';

const plugin: CinemaAdapterPlugin = {
  id: 'example',
  displayName: 'Example / Canary Plugin',
  description:
    'Minimal plugin that proves auto-discovery works. ' +
    'Also serves as a copy-paste template for new adapters.',

  defaultConfig: {
    exampleSetting: 'default-value',
  },

  validateConfig(config: CinemaConfig): ConfigValidationResult {
    const errors: string[] = [];
    try {
      requireString(config, 'baseUrl');
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
    }
    if (errors.length > 0) return { ok: false, errors };
    return { ok: true, config: mergeDefaults(config, plugin.defaultConfig) };
  },

  createAdapter(_cinemaId: string, _config: CinemaConfig): CinemaAdapter {
    // This is a canary — it returns an empty schedule. Real adapters should
    // fetch + parse HTML/JSON here.
    return {
      async fetchSchedule() {
        return { availableDays: [], movies: [] };
      },
    };
  },
};

export default plugin;
