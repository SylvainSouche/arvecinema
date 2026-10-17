import fs from 'node:fs';
import { loadCustomCinemas, type CinemaRegistrationResult } from './registry';
import { log } from '../ratings/moduleLoggers';

// ──────────────────────────────────────────────────────────────────────────
// Custom-cinemas file I/O helpers — shared by the IPC handlers.
//
// Kept electron-free (plain fs) so they are unit-testable without an
// electron mock — index.ts calls these with `customCinemasFile()` paths.
//
// The settings UI flow:
//   1. `cinemas:read-custom`  → readCustomCinemasFile() → form shows entries
//   2. user edits + saves     → `cinemas:save-custom`    → saveCustomCinemas()
//      → file written + loadCustomCinemas() re-registers → validation errors
//        are returned to the UI for display
//   3. main sends 'cinemas:changed' → renderer refetches the cinema list
// ──────────────────────────────────────────────────────────────────────────

/** Result of reading the custom-cinemas file for the settings form. */
export interface CustomCinemasReadResult {
  path: string;
  exists: boolean;
  /** Raw entries as stored in the file (possibly invalid — the UI edits
   *  them as-is; registry validation applies on save/reload). */
  cinemas: unknown[];
}

/**
 * Read the raw custom-cinemas file. Never throws: a missing file yields
 * `{ exists: false, cinemas: [] }`, a malformed file yields
 * `{ exists: true, cinemas: [] }` (the UI starts empty rather than
 * pre- filling with garbage the user can't edit safely).
 */
export function readCustomCinemasFile(filePath: string): CustomCinemasReadResult {
  if (!fs.existsSync(filePath)) {
    return { path: filePath, exists: false, cinemas: [] };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as { cinemas?: unknown };
    const list = Array.isArray(parsed?.cinemas) ? parsed.cinemas : [];
    return { path: filePath, exists: true, cinemas: list };
  } catch {
    return { path: filePath, exists: false, cinemas: [] };
  }
}

/** Result of saving + re-registering the custom cinema list. */
export interface CustomCinemasSaveResult {
  /** Whether the file was written (false only if `entries` isn't an array). */
  written: boolean;
  /** Full reload result — `registered` ids + per-entry rejection errors. */
  reload: CinemaRegistrationResult;
}

/**
 * Write the editor's list to the custom-cinemas file and re-register.
 * Passing `entries: []` removes all custom cinemas (file mirrors registry).
 * The file is always written to mirror the editor state (even if some
 * entries are invalid — they register-then-get-rejected and the errors are
 * reported back for display). Never throws for content problems; a
 * non-array input is rejected without writing anything.
 */
export function saveCustomCinemas(filePath: string, entries: unknown): CustomCinemasSaveResult {
  if (!Array.isArray(entries)) {
    const message = `saveCustomCinemas: expected an array, got ${typeof entries} — nothing written`;
    log.cinemas.error(message);
    return {
      written: false,
      reload: { registered: [], errors: [{ entry: 'request', message }] },
    };
  }
  fs.writeFileSync(filePath, JSON.stringify({ cinemas: entries }, null, 2) + '\n');
  const reload = loadCustomCinemas(filePath);
  return { written: true, reload };
}
