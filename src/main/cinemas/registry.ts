import type { Cinema } from './types';
import type { CinemaInfo } from '../../shared/types';
import { PLUGINS, getPlugin } from './adapters';
import type { CinemaInstance } from './adapters/plugin';
import { log } from '../ratings/moduleLoggers';

// ──────────────────────────────────────────────────────────────────────────
// CINEMA REGISTRY — fully drop-in, plugin-based.
//
// Both adapter TYPES and cinema INSTANCES are auto-discovered:
//   - Adapter types:    any `.ts` file in `src/main/cinemas/adapters/`
//                       (auto-discovered via `import.meta.glob` in
//                       `adapters/index.ts`)
//   - Cinema instances: any `.ts` file in `src/main/cinemas/instances/`
//                       (auto-discovered here via `import.meta.glob`)
//
// To add a new cinema: drop a `.ts` file in `instances/` exporting a
// `CinemaInstance` default. No edit to this file or any other file is
// required. Restart the app and the cinema appears.
//
// To add a new adapter type: drop a `.ts` file in `adapters/` exporting a
// `CinemaAdapterPlugin` default. No edit to this file or any other file is
// required. Then reference the plugin's `id` in a cinema instance file's
// `adapter.kind` field.
// ──────────────────────────────────────────────────────────────────────────

// ── Auto-discover cinema instances ──────────────────────────────────────────
//
// Vite scans `instances/` at BUILD TIME and inlines imports for every `.ts`
// file. Each file exports a `CinemaInstance` default.
const instanceModules = import.meta.glob<CinemaInstance>('./instances/*.ts', {
  eager: true,
  import: 'default',
});

// ── Build the runtime Cinema[] list from discovered instances ──────────────
//
// Each instance is validated by its referenced plugin's `validateConfig`
// function. Invalid instances are skipped with a warning logged to the
// console + LogViewer — the rest of the cinemas still load.
function buildCinemas(): Cinema[] {
  const out: Cinema[] = [];
  const seenIds = new Set<string>();

  for (const [modulePath, instance] of Object.entries(instanceModules)) {
    if (!instance) {
      log.cinemas.warn(`[registry] ${modulePath}: no default export — skipping`);
      continue;
    }
    if (typeof instance !== 'object' || instance === null) {
      log.cinemas.warn(`[registry] ${modulePath}: default export is not an object — skipping`);
      continue;
    }
    if (typeof instance.id !== 'string' || instance.id.length === 0) {
      log.cinemas.warn(`[registry] ${modulePath}: missing or empty 'id' — skipping`);
      continue;
    }
    if (typeof instance.name !== 'string' || instance.name.length === 0) {
      log.cinemas.warn(`[registry] ${modulePath}: missing or empty 'name' — skipping`);
      continue;
    }
    if (typeof instance.city !== 'string' || instance.city.length === 0) {
      log.cinemas.warn(`[registry] ${modulePath}: missing or empty 'city' — skipping`);
      continue;
    }
    if (typeof instance.color !== 'string' || instance.color.length === 0) {
      log.cinemas.warn(`[registry] ${modulePath}: missing or empty 'color' — skipping`);
      continue;
    }
    if (typeof instance.adapter !== 'object' || instance.adapter === null) {
      log.cinemas.warn(`[registry] ${modulePath}: missing or invalid 'adapter' — skipping`);
      continue;
    }
    if (typeof instance.adapter.kind !== 'string' || instance.adapter.kind.length === 0) {
      log.cinemas.warn(`[registry] ${modulePath}: missing or empty 'adapter.kind' — skipping`);
      continue;
    }

    if (seenIds.has(instance.id)) {
      log.cinemas.warn(`[registry] ${modulePath}: duplicate cinema id "${instance.id}" — skipping`);
      continue;
    }
    seenIds.add(instance.id);

    const plugin = getPlugin(instance.adapter.kind);
    if (!plugin) {
      log.cinemas.error(
        `[registry] cinema "${instance.id}" references unknown adapter kind ` +
          `"${instance.adapter.kind}" — known kinds: ${PLUGINS.map((p) => p.id).join(', ')}. Skipping.`,
      );
      continue;
    }

    // Validate the adapter config — plugin may have defaults to merge in.
    let adapterConfig = instance.adapter;
    if (plugin.validateConfig) {
      const result = plugin.validateConfig(adapterConfig);
      if (!result.ok) {
        log.cinemas.error(
          `[registry] cinema "${instance.id}" has invalid config for "${plugin.id}":\n` +
            result.errors.map((e) => `  - ${e}`).join('\n'),
        );
        continue;
      }
      adapterConfig = result.config;
    }

    try {
      const adapter = plugin.createAdapter(instance.id, adapterConfig);
      out.push({
        id: instance.id,
        name: instance.name,
        city: instance.city,
        color: instance.color,
        adapter,
      });
    } catch (err) {
      log.cinemas.error(
        `[registry] cinema "${instance.id}" failed to instantiate "${plugin.id}": ` +
          (err instanceof Error ? err.message : String(err)),
      );
    }
  }

  log.cinemas.info(
    `[registry] loaded ${out.length} cinemas ` + `(${PLUGINS.length} adapter plugins available)`,
  );
  return out;
}

export const CINEMAS: Cinema[] = buildCinemas();

/** Public metadata exposed to the renderer (without the adapter function). */
export const CINEMA_INFOS: CinemaInfo[] = CINEMAS.map(({ id, name, city, color }) => ({
  id,
  name,
  city,
  color,
}));

// ── Backward compatibility ─────────────────────────────────────────────────

export { PLUGINS } from './adapters';
export type { CinemaAdapterPlugin, CinemaConfig, CinemaInstance } from './adapters/plugin';
