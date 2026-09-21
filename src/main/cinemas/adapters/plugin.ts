// ──────────────────────────────────────────────────────────────────────────
// CinemaAdapterPlugin — drop-in plugin contract.
//
// Each adapter is a self-contained module in `src/main/cinemas/adapters/`
// that exports a default `CinemaAdapterPlugin` object. The registry auto-
// discovers all plugins in the directory at startup.
//
// A plugin provides:
//   1. Metadata (id, displayName) — used for diagnostics + UI.
//   2. A factory function `createAdapter(cinemaId, config)` — returns a
//      `CinemaAdapter` instance bound to a specific cinema.
//   3. Optional config validation + defaults.
//
// Cinema instances (which cinema, what URL, what theaterId) live in
// `cinemas.config.json` next to the registry. Adding a new cinema site is
// now a config-only change — no code edits required.
//
// Adding a new adapter TYPE (e.g. a new CMS with a different scraping
// strategy) requires:
//   1. Create `src/main/cinemas/adapters/myAdapter.ts` exporting a default
//      `CinemaAdapterPlugin`.
//   2. The registry auto-discovers it on next startup.
//   3. Add cinema entries in `cinemas.config.json` referencing the new
//      plugin id.
//
// No other files in the app need to change.
// ──────────────────────────────────────────────────────────────────────────

import type { CinemaAdapter } from '../types';

/**
 * Configuration schema for a cinema instance.
 *
 * The `kind` field selects which plugin handles this cinema.
 * All other fields are plugin-specific (baseUrl, theaterId, etc.) —
 * the plugin's `validateConfig` function is responsible for checking them.
 */
export interface CinemaConfig {
  /** Plugin identifier (e.g. "boxofficeapi", "cinevox"). Must match a
   *  registered plugin's `id`. */
  kind: string;
  /** Plugin-specific config (baseUrl, theaterId, schedulePath, etc.). */
  [key: string]: unknown;
}

/**
 * The result of validating a cinema config.
 * - `ok: true` — config is valid, use it as-is.
 * - `ok: false` — config is invalid; `errors` lists the problems.
 */
export type ConfigValidationResult =
  { ok: true; config: CinemaConfig } | { ok: false; errors: string[] };

/**
 * Drop-in adapter plugin contract.
 *
 * Each plugin module in `src/main/cinemas/adapters/` must export a default
 * object implementing this interface.
 */
export interface CinemaAdapterPlugin {
  /** Unique identifier for this adapter type (e.g. "boxofficeapi", "cinevox").
   *  Used in `cinemas.config.json` to select which plugin handles each cinema.
   *  Must be lowercase, alphanumeric + dashes only. */
  readonly id: string;

  /** Human-readable name for diagnostics + UI (e.g. "Box Office API"). */
  readonly displayName: string;

  /** Optional one-line description of what kind of cinema site this handles
   *  (e.g. "Gatsby + gatsby-source-boxofficeapi stack"). */
  readonly description?: string;

  /** Optional default config applied on top of the user's config (shallow
   *  merge — user values take precedence). Useful for plugins with
   *  sensible defaults like `schedulePath: '/horaires/'`. */
  readonly defaultConfig?: Partial<CinemaConfig>;

  /** Validate the config before instantiating the adapter.
   *  Called once at app startup. Returns `{ ok: true, config }` with a
   *  normalized config (defaults applied), or `{ ok: false, errors }`.
   *
   *  Default implementation: just returns `{ ok: true, config }`. */
  validateConfig?(config: CinemaConfig): ConfigValidationResult;

  /** Create a `CinemaAdapter` instance for one cinema.
   *
   *  @param cinemaId  the slug used in `cinemaId` fields of resulting
   *                   Showtime/Movie objects (e.g. "mont-blanc")
   *  @param config    the validated, defaults-merged config for this cinema
   *                   (baseUrl, theaterId, etc.)
   *  @returns         a CinemaAdapter instance — typically a fresh object
   *                   per call so each cinema gets its own closure */
  createAdapter(cinemaId: string, config: CinemaConfig): CinemaAdapter;
}

// ── Helpers for plugin authors ──────────────────────────────────────────────

/** Convenience: assert that `config[key]` is a non-empty string.
 *  Returns the string on success, throws on failure.
 *  Used inside `validateConfig` implementations. */
export function requireString(config: CinemaConfig, key: string): string {
  const v = config[key];
  if (typeof v !== 'string' || v.length === 0) {
    throw new Error(`config.${key} must be a non-empty string (got ${JSON.stringify(v)})`);
  }
  return v;
}

/** Convenience: assert that `config[key]` is a string, with a fallback.
 *  Returns the string or `fallback` if the key is missing or invalid. */
export function optionalString(config: CinemaConfig, key: string, fallback: string): string {
  const v = config[key];
  return typeof v === 'string' && v.length > 0 ? v : fallback;
}

/** Convenience: merge `defaultConfig` on top of `config` (shallow).
 *  User values take precedence. */
export function mergeDefaults(
  config: CinemaConfig,
  defaults?: Partial<CinemaConfig>,
): CinemaConfig {
  if (!defaults) return config;
  return { ...defaults, ...config };
}

// ── Cinema instance definition (one file per cinema site) ──────────────────
//
// A cinema instance is a real-world cinema: its id, name, city, color,
// and which adapter (plugin) handles it + the adapter-specific config.
//
// Each cinema lives in its own file under `src/main/cinemas/instances/`.
// The registry auto-discovers these files via `import.meta.glob()`.
//
// To add a new cinema: drop a `.ts` file in `instances/` exporting a
// `CinemaInstance` default. No edit to any other file is required.

export interface CinemaInstance {
  /** Stable slug, e.g. "mont-blanc". Used in IPC payloads + filter state. */
  id: string;
  /** Display name, e.g. "Ciné Mont-Blanc". */
  name: string;
  /** City, e.g. "Sallanches". */
  city: string;
  /** Hex color used for the cinema badge on each showtime chip. */
  color: string;
  /** Adapter config — `kind` selects the plugin, other fields are
   *  plugin-specific (baseUrl, theaterId, etc.). */
  adapter: CinemaConfig;
}
