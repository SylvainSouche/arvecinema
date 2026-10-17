import type { Cinema } from './types';
import type { CinemaInfo } from '../../shared/types';
import { PLUGINS, getPlugin } from './adapters';
import type { CinemaInstance } from './adapters/plugin';
import { log } from '../ratings/moduleLoggers';
import fs from 'node:fs';

// ──────────────────────────────────────────────────────────────────────────
// CINEMA REGISTRY — fully drop-in, plugin-based.
//
// Cinemas are registered from two sources:
//   1. BUILD TIME (bundled instances): any `.ts` file in
//      `src/main/cinemas/instances/` (auto-discovered via `import.meta.glob`).
//   2. RUN TIME (custom instances): a JSON file in the user's userData dir
//      (`custom-cinemas.json`, path assembled in `src/main/index.ts`). This
//      lets users add/remove cinemas WITHOUT touching the bundle — the
//      packaged app reads it at startup (and on reload via the
//      `cinemas:reload-custom` IPC). JSON only: no code execution, safe for
//      packaged builds.
//
// To add a bundled cinema: drop a `.ts` file in `instances/` exporting a
// `CinemaInstance` default. No edit to this file or any other file is
// required. Restart the app and the cinema appears.
//
// To add a new adapter type: drop a `.ts` file in `adapters/` exporting a
// `CinemaAdapterPlugin` default. No edit to this file or any other file is
// required. Then reference the plugin's `id` in a cinema instance file's
// `adapter.kind` field (or in custom-cinemas.json).
// ──────────────────────────────────────────────────────────────────────────

// ── Auto-discover bundled cinema instances ─────────────────────────────────
//
// Vite scans `instances/` at BUILD TIME and inlines imports for every `.ts`
// file. Each file exports a `CinemaInstance` default.
const instanceModules = import.meta.glob<CinemaInstance>('./instances/*.ts', {
  eager: true,
  import: 'default',
});

// ── Validation helpers ─────────────────────────────────────────────────────
//
// Shared by the bundled-instance loader (buildCinemas) and the runtime
// custom-instance loader (loadCustomCinemas) so both paths enforce the
// exact same rules.

/** Validate the `CinemaInstance` shape of a parsed entry. Returns the list
 *  of problems (empty = valid). Works on `unknown` entries (parsed JSON) —
 *  every field is checked defensively, never trusted. */
function validateCinemaShape(instance: unknown, context: string): string[] {
  const errors: string[] = [];
  const push = (msg: string) => errors.push(`${context}: ${msg}`);

  if (typeof instance !== 'object' || instance === null) {
    push('entry is not an object');
    return errors;
  }
  const inst = instance as Record<string, unknown>;

  for (const field of ['id', 'name', 'city', 'color'] as const) {
    if (typeof inst[field] !== 'string' || (inst[field] as string).length === 0) {
      push(`missing or empty '${field}'`);
    }
  }
  if (typeof inst.adapter !== 'object' || inst.adapter === null) {
    push(`missing or invalid 'adapter'`);
    return errors;
  }
  const adapter = inst.adapter as Record<string, unknown>;
  if (typeof adapter.kind !== 'string' || adapter.kind.length === 0) {
    push(`missing or empty 'adapter.kind'`);
  }
  if (inst.testOnly !== undefined && typeof inst.testOnly !== 'boolean') {
    push(`'testOnly' must be a boolean`);
  }
  return errors;
}

/** Resolve the plugin for an instance, validate the adapter config
 *  (plugin `validateConfig` + defaults merge), and instantiate the adapter.
 *  On failure the reason is logged AND returned so callers (e.g. the
 *  custom-instance loader) can surface it programmatically. */
function instantiateCinema(
  instance: CinemaInstance,
  context: string,
): { ok: true; cinema: Cinema } | { ok: false; message: string } {
  const plugin = getPlugin(instance.adapter.kind);
  if (!plugin) {
    const message =
      `${context} references unknown adapter kind "${instance.adapter.kind}" — ` +
        `known kinds: ${PLUGINS.map((p) => p.id).join(', ')}. Skipping.`;
    log.cinemas.error(message);
    return { ok: false, message };
  }

  // Validate the adapter config — plugin may have defaults to merge in.
  let adapterConfig = instance.adapter;
  if (plugin.validateConfig) {
    const result = plugin.validateConfig(adapterConfig);
    if (!result.ok) {
      const message =
        `${context} has invalid config for "${plugin.id}":\n` +
        result.errors.map((e) => `  - ${e}`).join('\n');
      log.cinemas.error(message);
      return { ok: false, message };
    }
    adapterConfig = result.config;
  }

  try {
    const adapter = plugin.createAdapter(instance.id, adapterConfig);
    return {
      ok: true,
      cinema: {
        id: instance.id,
        name: instance.name,
        city: instance.city,
        color: instance.color,
        adapter,
      },
    };
  } catch (err) {
    const message =
      `${context} failed to instantiate "${plugin.id}": ` +
      (err instanceof Error ? err.message : String(err));
    log.cinemas.error(message);
    return { ok: false, message };
  }
}

// ── Build the bundled Cinema[] list from discovered instances ──────────────
//
// Invalid instances are skipped with a warning logged to the console +
// LogViewer — the rest of the cinemas still load.
//
// Instances marked `testOnly: true` (canary/template instances) are
// registered only in dev + unit tests and skipped from bundled release
// builds. The discriminator is Vite's build-time `import.meta.env.DEV`:
//   - `electron-vite dev`  -> DEV=true  (canary registered)
//   - `vitest`             -> DEV=true  (canary registered, tests assert it)
//   - `electron-vite build`-> DEV=false (canary filtered out of releases)
// We never use `app.isPackaged` here: this module is imported by unit tests
// without an electron mock, where importing electron is not safe.
export function buildCinemas(options: { includeTestOnly?: boolean } = {}): Cinema[] {
  const includeTestOnly = options.includeTestOnly ?? import.meta.env.DEV;
  const out: Cinema[] = [];
  const seenIds = new Set<string>();

  for (const [modulePath, instance] of Object.entries(instanceModules)) {
    if (!includeTestOnly && instance?.testOnly) {
      log.cinemas.info(`[registry] ${modulePath}: test-only instance — skipping in release build`);
      continue;
    }
    if (!instance) {
      log.cinemas.warn(`[registry] ${modulePath}: no default export — skipping`);
      continue;
    }

    const errors = validateCinemaShape(instance, `[registry] ${modulePath}`);
    if (errors.length > 0) {
      log.cinemas.warn(`${errors.join('\n')} — skipping`);
      continue;
    }

    if (seenIds.has(instance.id)) {
      log.cinemas.warn(`[registry] ${modulePath}: duplicate cinema id "${instance.id}" — skipping`);
      continue;
    }
    seenIds.add(instance.id);

    const cinema = instantiateCinema(instance, `[registry] cinema "${instance.id}"`);
    if (cinema.ok) out.push(cinema.cinema);
  }

  log.cinemas.info(
    `[registry] loaded ${out.length} cinemas ` + `(${PLUGINS.length} adapter plugins available)`,
  );
  return out;
}

// ── Runtime registry state ─────────────────────────────────────────────────
//
// `CINEMAS` is a stable array whose CONTENTS change as custom cinemas are
// registered/unregistered. Consumers hold a live view — no reassignment, so
// every import of `CINEMAS` always reflects the current registry.
const cinemaList: Cinema[] = buildCinemas();

export const CINEMAS: Cinema[] = cinemaList;

// The custom (runtime, userData) slice — kept apart for atomic replacement.
let customCinemas: Cinema[] = [];

/** Public metadata exposed to the renderer at call time (without the
 *  adapter function). Includes custom cinemas registered after startup. */
export function getCinemaInfos(): CinemaInfo[] {
  return cinemaList.map(({ id, name, city, color }) => ({ id, name, city, color }));
}

/**
 * Snapshot of the BUNDLED cinema infos, taken at module load. Kept for
 * backward compatibility; always prefer {@link getCinemaInfos} — this does
 * not reflect runtime-registered custom cinemas.
 */
export const CINEMA_INFOS: CinemaInfo[] = cinemaList.map(({ id, name, city, color }) => ({
  id,
  name,
  city,
  color,
}));

// ── Runtime custom cinemas (userData JSON) ─────────────────────────────────

/** Ids currently registered from the runtime custom set. */
export function getCustomCinemaIds(): string[] {
  return customCinemas.map((c) => c.id);
}

/** Remove all runtime-registered custom instances (builtins are untouched). */
export function unregisterCustomCinemas(): void {
  const customIds = new Set(customCinemas.map((c) => c.id));
  for (let i = cinemaList.length - 1; i >= 0; i--) {
    if (customIds.has(cinemaList[i].id)) cinemaList.splice(i, 1);
  }
  customCinemas = [];
}

/** Result of loading a custom-cinemas file. */
export interface CinemaRegistrationResult {
  /** Ids of custom instances successfully registered (replacing any
   *  previous custom set). */
  registered: string[];
  /** One entry per rejected item (or for the file itself), each with a
   *  reason. Valid entries are still registered; only invalid ones are
   *  skipped. */
  errors: Array<{ entry: string; message: string }>;
}

/**
 * Register runtime custom cinemas from a JSON file. Expected shape:
 *
 *   { "cinemas": [ { "id", "name", "city", "color", "adapter": { "kind", ... } } ] }
 *
 * Rules (same validation as bundled instances):
 *   - entries failing shape checks or plugin `validateConfig` are skipped
 *     (reported via `errors`); valid entries still register;
 *   - a custom id colliding with a builtin id is rejected;
 *   - a duplicate id within the file registers only the first occurrence.
 *
 * Replacing behaviour: the custom set mirrors the FILE — each call replaces
 * the entire custom set with the file's valid entries, so REMOVING an entry
 * from the file removes that cinema on the next load (and an empty
 * `cinemas` array removes all custom cinemas). An unreadable/malformed file
 * is the exception: it keeps the previous custom set untouched so a
 * corrupted file can never silently wipe a user's custom cinemas.
 * A missing file is a clean no-op (registered = [], errors = []).
 *
 * The `testOnly` flag, if present, is accepted by shape validation but
 * ignored here — an explicitly user-authored runtime instance is considered
 * intentional.
 *
 * Never throws: every failure mode is captured in the returned `errors` so
 * the caller can surface them (UI/diagnostics) without crashing startup.
 */
export function loadCustomCinemas(filePath: string): CinemaRegistrationResult {
  if (!fs.existsSync(filePath)) {
    log.cinemas.info(`[registry] no custom-cinemas file at ${filePath} — nothing to load`);
    return { registered: [], errors: [] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    const message = `custom-cinemas file is not valid JSON: ${
      err instanceof Error ? err.message : String(err)
    }`;
    log.cinemas.error(`[registry] ${message}`);
    return { registered: [], errors: [{ entry: filePath, message }] };
  }

  const cinemasField = (parsed as { cinemas?: unknown } | null)?.cinemas;
  if (!Array.isArray(cinemasField)) {
    const message = "custom-cinemas file must contain a 'cinemas' array";
    log.cinemas.error(`[registry] ${message}`);
    return { registered: [], errors: [{ entry: filePath, message }] };
  }

  // Ids already claimed by BUNDLED instances (custom must not override them).
  const customIds = new Set(customCinemas.map((c) => c.id));
  const bundledIds = new Set(cinemaList.filter((c) => !customIds.has(c.id)).map((c) => c.id));
  const fileSeenIds = new Set<string>();

  const errors: CinemaRegistrationResult['errors'] = [];
  const validated: CinemaInstance[] = [];

  cinemasField.forEach((entry, i) => {
    const context = `cinemas[${i}]`;
    const shapeErrors = validateCinemaShape(entry, context);
    if (shapeErrors.length > 0) {
      errors.push({ entry: context, message: shapeErrors.join('; ') });
      return;
    }
    const inst = entry as CinemaInstance;

    if (bundledIds.has(inst.id) || fileSeenIds.has(inst.id)) {
      errors.push({
        entry: context,
        message: `duplicate cinema id "${inst.id}" — skipping`,
      });
      return;
    }
    fileSeenIds.add(inst.id);
    validated.push(inst);
  });

  // World-state replacement: structurally valid file → the custom set
  // becomes exactly this file's valid entries. Malformed files never reach
  // this point (they returned above), so corruption can't wipe customs.
  unregisterCustomCinemas();
  const registered: string[] = [];
  for (const inst of validated) {
    const result = instantiateCinema(inst, `[registry] custom cinema "${inst.id}"`);
    if (result.ok) {
      cinemaList.push(result.cinema);
      customCinemas.push(result.cinema);
      registered.push(result.cinema.id);
    } else {
      errors.push({ entry: `custom:${inst.id}`, message: result.message });
    }
  }

  log.cinemas.info(
    `[registry] custom cinemas: ${registered.length} registered` +
      (errors.length > 0 ? `, ${errors.length} rejected` : ''),
  );
  return { registered, errors };
}

// ── Backward compatibility ─────────────────────────────────────────────────

export { PLUGINS } from './adapters';
export type { CinemaAdapterPlugin, CinemaConfig, CinemaInstance } from './adapters/plugin';
