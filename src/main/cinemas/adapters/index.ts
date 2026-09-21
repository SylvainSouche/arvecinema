// ──────────────────────────────────────────────────────────────────────────
// Adapter plugin registry — TRUE drop-in auto-discovery.
//
// Adding a new adapter TYPE (e.g. for a cinema using a different CMS):
//   1. Create `src/main/cinemas/adapters/myAdapter.ts` exporting a default
//      `CinemaAdapterPlugin` object.
//   2. Add cinema entries in `cinemas.config.json` referencing the plugin's
//      `id` in the `kind` field.
//
// That's it — no edit to this file. The new plugin is auto-discovered at
// build time via Vite's `import.meta.glob()`.
//
// Adding a new cinema SITE using an existing adapter type (e.g. another
// boxofficeapi-powered cinema):
//   1. Add the cinema entry to `cinemas.config.json` with the existing
//      plugin's `id` in the `kind` field.
//   2. No code changes needed.
// ──────────────────────────────────────────────────────────────────────────

import type { CinemaAdapterPlugin } from './plugin';
import { log } from '../../ratings/moduleLoggers';

// ── Auto-discovery via Vite's import.meta.glob() ───────────────────────────
//
// This is the magic that makes the system truly drop-in. Vite scans the
// `adapters/` directory at BUILD TIME and inlines imports for every `.ts`
// file (except `index.ts` and `plugin.ts` which are infrastructure).
//
// The `{ eager: true }` option makes the imports synchronous — we get the
// module objects directly, no async loading needed.
//
// The `{ import: 'default' }` option extracts the default export directly,
// so `pluginModules[path]` IS the plugin object (not `{ default: plugin }`).
const pluginModules = import.meta.glob<CinemaAdapterPlugin>('./!(index|plugin).ts', {
  eager: true,
  import: 'default',
});

// ── Build the plugin list + validate each entry ────────────────────────────
//
// We collect all discovered plugins, skip any that don't conform to the
// CinemaAdapterPlugin shape (e.g. a half-written plugin file someone
// forgot to finish), and warn loudly so the developer notices.
const PLUGINS_LIST: CinemaAdapterPlugin[] = [];
const seenIds = new Set<string>();

for (const [modulePath, plugin] of Object.entries(pluginModules)) {
  if (!plugin) {
    log.cinemas.warn(`[adapters] ${modulePath}: no default export — skipping`);
    continue;
  }
  if (typeof plugin !== 'object' || plugin === null) {
    log.cinemas.warn(`[adapters] ${modulePath}: default export is not an object — skipping`);
    continue;
  }
  if (typeof plugin.id !== 'string' || plugin.id.length === 0) {
    log.cinemas.warn(`[adapters] ${modulePath}: missing or empty 'id' field — skipping`);
    continue;
  }
  if (typeof plugin.createAdapter !== 'function') {
    log.cinemas.warn(`[adapters] ${modulePath}: missing 'createAdapter' function — skipping`);
    continue;
  }
  if (typeof plugin.displayName !== 'string' || plugin.displayName.length === 0) {
    log.cinemas.warn(`[adapters] ${modulePath}: missing or empty 'displayName' — skipping`);
    continue;
  }
  if (seenIds.has(plugin.id)) {
    log.cinemas.warn(`[adapters] ${modulePath}: duplicate plugin id "${plugin.id}" — skipping`);
    continue;
  }
  seenIds.add(plugin.id);
  PLUGINS_LIST.push(plugin);
}

// ── Public API ──────────────────────────────────────────────────────────────

export const PLUGINS: readonly CinemaAdapterPlugin[] = Object.freeze(PLUGINS_LIST);

/** Index of plugins by their `id` field. Built once at module load. */
const PLUGIN_BY_ID: ReadonlyMap<string, CinemaAdapterPlugin> = new Map(
  PLUGINS.map((p) => [p.id, p]),
);

/** Look up a plugin by id. Returns undefined if not found. */
export function getPlugin(id: string): CinemaAdapterPlugin | undefined {
  return PLUGIN_BY_ID.get(id);
}

/** List all registered plugin ids (for diagnostics + UI). */
export function listPluginIds(): string[] {
  return PLUGINS.map((p) => p.id);
}

/** List all registered plugins with their metadata (for diagnostics UI). */
export function listPlugins(): ReadonlyArray<{
  id: string;
  displayName: string;
  description?: string;
}> {
  return PLUGINS.map((p) => ({
    id: p.id,
    displayName: p.displayName,
    description: p.description,
  }));
}
