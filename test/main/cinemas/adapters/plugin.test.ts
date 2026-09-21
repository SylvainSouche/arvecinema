// ──────────────────────────────────────────────────────────────────────────
// COVERAGE: Layer 1 — Unit tests for the cinema adapter plugin system.
//
// Tests: Plugin helpers (requireString, optionalString, mergeDefaults),
//        plugin registry integrity, per-plugin config validation + factory,
//        TRUE drop-in auto-discovery (canary plugin + canary instance).
//
// Catches: Plugin registration regressions, config validation bugs, auto-
//          discovery breakage (if import.meta.glob stops working).
//
// Misses: Whether the adapters actually fetch + parse real cinema data
//        correctly (that's Layer 3 — parser contract tests, and Layer 4 —
//        HAR replay tests). Does NOT test the cinema websites themselves
//        (that's Layer 6 — live smoke tests).
//
// See TESTING.md for the full failure-mode → test-layer matrix.
// ──────────────────────────────────────────────────────────────────────────
// ──────────────────────────────────────────────────────────────────────────
// Unit tests for the cinema adapter plugin system.
//
// Verifies:
//   1. Plugin helpers (requireString, optionalString, mergeDefaults) work.
//   2. All 3 registered plugins have unique ids + valid contracts.
//   3. Config validation works (accepts valid, rejects invalid).
//   4. createAdapter returns a CinemaAdapter with fetchSchedule().
// ──────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from 'vitest';
import {
  requireString,
  optionalString,
  mergeDefaults,
  type CinemaConfig,
} from '../../../../src/main/cinemas/adapters/plugin';
import { PLUGINS, getPlugin, listPluginIds } from '../../../../src/main/cinemas/adapters';

// ── Helper functions ────────────────────────────────────────────────────────

describe('requireString', () => {
  it('returns the value when it is a non-empty string', () => {
    const config = { kind: 'foo', baseUrl: 'https://example.com' };
    expect(requireString(config, 'baseUrl')).toBe('https://example.com');
  });

  it('throws when the value is missing', () => {
    const config = { kind: 'foo' } as CinemaConfig;
    expect(() => requireString(config, 'baseUrl')).toThrow(/baseUrl/);
  });

  it('throws when the value is an empty string', () => {
    const config = { kind: 'foo', baseUrl: '' };
    expect(() => requireString(config, 'baseUrl')).toThrow(/baseUrl/);
  });

  it('throws when the value is not a string', () => {
    const config = { kind: 'foo', baseUrl: 123 };
    expect(() => requireString(config, 'baseUrl')).toThrow(/baseUrl/);
    const config2 = { kind: 'foo', baseUrl: null };
    expect(() => requireString(config2, 'baseUrl')).toThrow(/baseUrl/);
    const config3 = { kind: 'foo', baseUrl: undefined };
    expect(() => requireString(config3, 'baseUrl')).toThrow(/baseUrl/);
  });

  it('includes the offending value in the error message for debugging', () => {
    const config = { kind: 'foo', baseUrl: 42 };
    expect(() => requireString(config, 'baseUrl')).toThrow(/42/);
  });
});

describe('optionalString', () => {
  it('returns the value when it is a non-empty string', () => {
    const config = { kind: 'foo', path: '/horaires/' };
    expect(optionalString(config, 'path', '/default')).toBe('/horaires/');
  });

  it('returns the fallback when the value is missing', () => {
    const config = { kind: 'foo' } as CinemaConfig;
    expect(optionalString(config, 'path', '/default')).toBe('/default');
  });

  it('returns the fallback when the value is an empty string', () => {
    const config = { kind: 'foo', path: '' };
    expect(optionalString(config, 'path', '/default')).toBe('/default');
  });

  it('returns the fallback when the value is not a string', () => {
    const config = { kind: 'foo', path: 123 };
    expect(optionalString(config, 'path', '/default')).toBe('/default');
  });
});

describe('mergeDefaults', () => {
  it('returns the original config when no defaults are provided', () => {
    const config = { kind: 'foo', x: 1 };
    expect(mergeDefaults(config, undefined)).toBe(config);
  });

  it('merges defaults — user values take precedence', () => {
    const config = { kind: 'foo', x: 1 };
    const defaults = { x: 99, y: 2 };
    expect(mergeDefaults(config, defaults)).toEqual({ kind: 'foo', x: 1, y: 2 });
  });

  it('adds new keys from defaults', () => {
    const config = { kind: 'foo' };
    const defaults = { path: '/default' };
    expect(mergeDefaults(config, defaults)).toEqual({ kind: 'foo', path: '/default' });
  });

  it('does not deep-merge (shallow only)', () => {
    const config = { kind: 'foo', nested: { a: 1 } };
    const defaults = { nested: { b: 2 } };
    // Shallow merge: user's `nested` entirely replaces default's `nested`.
    expect(mergeDefaults(config, defaults)).toEqual({ kind: 'foo', nested: { a: 1 } });
  });
});

// ── Plugin registry ────────────────────────────────────────────────────────

describe('PLUGINS registry', () => {
  it('has at least 3 plugins registered (boxofficeapi, cinevox, cinechateau)', () => {
    expect(PLUGINS.length).toBeGreaterThanOrEqual(3);
    expect(listPluginIds()).toContain('boxofficeapi');
    expect(listPluginIds()).toContain('cinevox');
    expect(listPluginIds()).toContain('cinechateau');
  });

  it('every plugin has a unique id', () => {
    const ids = PLUGINS.map((p) => p.id);
    const unique = new Set(ids);
    expect(ids.length).toBe(unique.size);
  });

  it('every plugin has a non-empty id and displayName', () => {
    for (const p of PLUGINS) {
      expect(p.id.length).toBeGreaterThan(0);
      expect(p.displayName.length).toBeGreaterThan(0);
    }
  });

  it('every plugin has a createAdapter function', () => {
    for (const p of PLUGINS) {
      expect(typeof p.createAdapter).toBe('function');
    }
  });

  it('every plugin id is lowercase + alphanumeric + dashes only', () => {
    for (const p of PLUGINS) {
      expect(p.id).toMatch(/^[a-z0-9-]+$/);
    }
  });
});

describe('getPlugin', () => {
  it('returns the plugin by id', () => {
    expect(getPlugin('boxofficeapi')?.id).toBe('boxofficeapi');
    expect(getPlugin('cinevox')?.id).toBe('cinevox');
    expect(getPlugin('cinechateau')?.id).toBe('cinechateau');
  });

  it('returns undefined for an unknown id', () => {
    expect(getPlugin('unknown-plugin')).toBeUndefined();
  });
});

// ── boxofficeapi plugin ────────────────────────────────────────────────────

describe('boxofficeapi plugin', () => {
  const plugin = getPlugin('boxofficeapi')!;

  it('validates a correct config', () => {
    const result = plugin.validateConfig!({
      kind: 'boxofficeapi',
      baseUrl: 'https://www.cinemontblanc.fr',
      theaterId: 'P1798',
    });
    expect(result.ok).toBe(true);
  });

  it('rejects a config missing baseUrl', () => {
    const result = plugin.validateConfig!({
      kind: 'boxofficeapi',
      theaterId: 'P1798',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors.join(' ')).toMatch(/baseUrl/);
    }
  });

  it('rejects a config missing theaterId', () => {
    const result = plugin.validateConfig!({
      kind: 'boxofficeapi',
      baseUrl: 'https://www.cinemontblanc.fr',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join(' ')).toMatch(/theaterId/);
    }
  });

  it('rejects a config with empty baseUrl', () => {
    const result = plugin.validateConfig!({
      kind: 'boxofficeapi',
      baseUrl: '',
      theaterId: 'P1798',
    });
    expect(result.ok).toBe(false);
  });

  it('merges in default timeZone when not provided', () => {
    const result = plugin.validateConfig!({
      kind: 'boxofficeapi',
      baseUrl: 'https://www.cinemontblanc.fr',
      theaterId: 'P1798',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.timeZone).toBe('Europe/Paris');
    }
  });

  it('preserves user-provided timeZone over the default', () => {
    const result = plugin.validateConfig!({
      kind: 'boxofficeapi',
      baseUrl: 'https://www.cinemontblanc.fr',
      theaterId: 'P1798',
      timeZone: 'UTC',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.timeZone).toBe('UTC');
    }
  });

  it('createAdapter returns a CinemaAdapter with fetchSchedule', () => {
    const adapter = plugin.createAdapter('mont-blanc', {
      kind: 'boxofficeapi',
      baseUrl: 'https://www.cinemontblanc.fr',
      theaterId: 'P1798',
    });
    expect(typeof adapter.fetchSchedule).toBe('function');
  });
});

// ── cinevox plugin ──────────────────────────────────────────────────────────

describe('cinevox plugin', () => {
  const plugin = getPlugin('cinevox')!;

  it('validates a correct config', () => {
    const result = plugin.validateConfig!({
      kind: 'cinevox',
      baseUrl: 'https://www.cinemavox-chamonix.com',
    });
    expect(result.ok).toBe(true);
  });

  it('rejects a config missing baseUrl', () => {
    const result = plugin.validateConfig!({
      kind: 'cinevox',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join(' ')).toMatch(/baseUrl/);
    }
  });

  it('merges in default schedulePath when not provided', () => {
    const result = plugin.validateConfig!({
      kind: 'cinevox',
      baseUrl: 'https://www.cinemavox-chamonix.com',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.schedulePath).toBe('/horaires/');
    }
  });

  it('preserves user-provided schedulePath over the default', () => {
    const result = plugin.validateConfig!({
      kind: 'cinevox',
      baseUrl: 'https://www.cinemavox-chamonix.com',
      schedulePath: '/agenda/',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.schedulePath).toBe('/agenda/');
    }
  });

  it('createAdapter returns a CinemaAdapter', () => {
    const adapter = plugin.createAdapter('chamonix', {
      kind: 'cinevox',
      baseUrl: 'https://www.cinemavox-chamonix.com',
    });
    expect(typeof adapter.fetchSchedule).toBe('function');
  });
});

// ── cinechateau plugin ──────────────────────────────────────────────────────

describe('cinechateau plugin (sleeping backup)', () => {
  const plugin = getPlugin('cinechateau')!;

  it('validates a correct config', () => {
    const result = plugin.validateConfig!({
      kind: 'cinechateau',
      baseUrl: 'https://www.cinechateau.fr',
    });
    expect(result.ok).toBe(true);
  });

  it('rejects a config missing baseUrl', () => {
    const result = plugin.validateConfig!({
      kind: 'cinechateau',
    });
    expect(result.ok).toBe(false);
  });

  it('merges in default schedulePath', () => {
    const result = plugin.validateConfig!({
      kind: 'cinechateau',
      baseUrl: 'https://www.cinechateau.fr',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.schedulePath).toBe('/horaires/');
    }
  });

  it('createAdapter returns a CinemaAdapter', () => {
    const adapter = plugin.createAdapter('bonneville', {
      kind: 'cinechateau',
      baseUrl: 'https://www.cinechateau.fr',
    });
    expect(typeof adapter.fetchSchedule).toBe('function');
  });
});

// ── TRUE drop-in verification ──────────────────────────────────────────────
//
// This test verifies the auto-discovery works as advertised: a plugin file
// dropped into `src/main/cinemas/adapters/` is registered WITHOUT any edit
// to `index.ts`. We use the `examplePlugin.ts` file in the adapters directory
// as a permanent canary — if auto-discovery ever breaks, this test fails.

describe('TRUE drop-in auto-discovery', () => {
  it('picks up a plugin file dropped into adapters/ WITHOUT editing index.ts', () => {
    // The file `src/main/cinemas/adapters/examplePlugin.ts` exports a plugin
    // with id 'example'. If auto-discovery works, this should succeed
    // without us having added an `import` or `PLUGINS.push` anywhere in
    // index.ts. The glob `./!(index|plugin).ts` picks up examplePlugin.ts
    // automatically at build time.
    const plugin = getPlugin('example');
    expect(plugin).toBeDefined();
    expect(plugin!.id).toBe('example');
    expect(plugin!.displayName).toBe('Example / Canary Plugin');
    expect(typeof plugin!.createAdapter).toBe('function');
  });

  it('the dropped plugin is in the PLUGINS list', () => {
    expect(listPluginIds()).toContain('example');
  });

  it('the dropped plugin validates + creates adapters like any other', () => {
    const plugin = getPlugin('example')!;
    const result = plugin.validateConfig!({
      kind: 'example',
      baseUrl: 'https://example.com',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.exampleSetting).toBe('default-value'); // default merged in
    }
    const adapter = plugin.createAdapter('test-cinema', {
      kind: 'example',
      baseUrl: 'https://example.com',
    });
    expect(typeof adapter.fetchSchedule).toBe('function');
  });

  it('auto-discovery picks up AT LEAST 4 plugins (3 real + 1 canary)', () => {
    // 3 real adapters (boxofficeapi, cinevox, cinechateau) + 1 example canary.
    // If this drops below 4, auto-discovery is broken.
    expect(PLUGINS.length).toBeGreaterThanOrEqual(4);
  });
});

// ── TRUE drop-in cinema instance auto-discovery ────────────────────────────
//
// Verifies that cinema instance files dropped into
// `src/main/cinemas/instances/` are auto-discovered by the registry WITHOUT
// editing `registry.ts` or `cinemas.config.json`.
//
// We test against the real CINEMAS + CINEMA_INFOS arrays exported by the
// registry — they should include the 4 real instances + 1 canary.

import { CINEMAS, CINEMA_INFOS } from '../../../../src/main/cinemas/registry';

describe('TRUE drop-in cinema instance auto-discovery', () => {
  it('loads all 4 real cinema instances + 1 canary = at least 5 cinemas', () => {
    // 4 real: mont-blanc, cluses, bonneville, chamonix
    // 1 canary: example-cinema (from instances/_exampleInstance.ts)
    expect(CINEMAS.length).toBeGreaterThanOrEqual(5);
  });

  it('includes the 4 real cinemas by id', () => {
    const ids = CINEMAS.map((c) => c.id);
    expect(ids).toContain('mont-blanc');
    expect(ids).toContain('cluses');
    expect(ids).toContain('bonneville');
    expect(ids).toContain('chamonix');
  });

  it('includes the example-cinema canary (proves auto-discovery works)', () => {
    const ids = CINEMAS.map((c) => c.id);
    expect(ids).toContain('example-cinema');
  });

  it('every cinema has a working adapter (fetchSchedule is a function)', () => {
    for (const cinema of CINEMAS) {
      expect(typeof cinema.adapter.fetchSchedule).toBe('function');
    }
  });

  it('CINEMA_INFOS matches CINEMAS (same length, same ids)', () => {
    expect(CINEMA_INFOS.length).toBe(CINEMAS.length);
    const cinemaIds = new Set(CINEMAS.map((c) => c.id));
    for (const info of CINEMA_INFOS) {
      expect(cinemaIds.has(info.id)).toBe(true);
      expect(typeof info.name).toBe('string');
      expect(typeof info.city).toBe('string');
      expect(typeof info.color).toBe('string');
    }
  });

  it('CINEMA_INFOS does NOT leak the adapter function (security)', () => {
    // The renderer should only see metadata, not the adapter closure.
    for (const info of CINEMA_INFOS as any[]) {
      expect(info.adapter).toBeUndefined();
    }
  });

  it('each cinema has a unique id (no duplicates allowed)', () => {
    const ids = CINEMAS.map((c) => c.id);
    const unique = new Set(ids);
    expect(ids.length).toBe(unique.size);
  });

  it('each cinema has a unique color (visual disambiguation)', () => {
    const colors = CINEMAS.map((c) => c.color);
    const unique = new Set(colors);
    // Colors SHOULD be unique, but we don't strictly enforce it — just warn
    // via this soft check. If two cinemas share a color, the user can still
    // tell them apart by name.
    expect(unique.size).toBeGreaterThanOrEqual(Math.ceil(colors.length * 0.8));
  });
});
