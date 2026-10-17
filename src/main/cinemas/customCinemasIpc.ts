import fs from 'node:fs';
import path from 'node:path';
import { loadCustomCinemas, type CinemaRegistrationResult } from './registry';
import { log } from '../ratings/moduleLoggers';

// ──────────────────────────────────────────────────────────────────────────
// Custom-cinemas file I/O helpers — shared by the IPC handlers.
//
// Kept electron-free (plain fs + registry) so they are unit-testable
// without an electron mock — index.ts calls these with
// `customCinemasFile()` paths.
//
// The settings UI flow:
//   1. `cinemas:read-custom`  → readCustomCinemasFile() → form shows entries
//   2. user edits + saves     → `cinemas:save-custom`    → saveCustomCinemas()
//      → file written + loadCustomCinemas() re-registers → validation errors
//        are returned to the UI for display
//   3. main sends 'cinemas:changed' → renderer refetches the cinema list
//
// Write safety (review DATA-02):
//   - the COMPLETE configuration is validated structurally BEFORE anything
//     is committed — a save containing a malformed entry is rejected
//     wholesale and leaves the previous file (last-known-good) untouched
//   - registry/business-level validation (unknown kind, bad URL, hijacked
//     ids) still applies AFTER the write via loadCustomCinemas; those rows
//     stay visible in the editor (they are work-in-progress the user
//     should be able to fix, not garbage) and the registry skips them
//   - the write itself is atomic: fsync'd temp file + rename in the same
//     directory, so a crash/interrupted sweep can never leave a truncated
//     JSON file — the rename either lands the old or the new bytes
//   - every successful save refreshes a `.lkg` sibling with the same
//     content (best-effort) so manual recovery is possible
//   - size limits: ≤ MAX_CUSTOM_CINEMAS entries, per-field length caps
// ──────────────────────────────────────────────────────────────────────────

/** Hard cap on custom cinema count (sanity bound, not product guidance). */
export const MAX_CUSTOM_CINEMAS = 50;

const MAX_STRING_FIELD = 200;
const MAX_URL_LENGTH = 2048;

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
 * `{ exists: false, cinemas: [] }` (the UI starts empty rather than
 * pre-filling with garbage the user can't edit safely).
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
  /** Whether the file was written (false if the input was rejected). */
  written: boolean;
  /** Full reload result — `registered` ids + per-entry rejection errors. */
  reload: CinemaRegistrationResult;
}

type StructuralError = { entry: string; message: string };

/**
 * Structural (shape-level) validation of one custom cinema entry —
 * deliberately weaker than the registry's business validation: kind/
 * plugin/URL semantics belong to the registry. Here we only guarantee
 * that what reaches the disk is sane JSON-shaped data with bounded
 * field sizes (a lot of these checks also protect the JSON writer from
 * absurd input).
 */
export function validateCustomEntryShape(entry: unknown, index: number): StructuralError[] {
  const label = `cinemas[${index}]`;
  const errors: StructuralError[] = [];
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    return [{ entry: label, message: 'must be an object' }];
  }
  const e = entry as Record<string, unknown>;

  // id is optional (slugs are assignable in the UI); when present it must be
  // a safe slug so it can never touch disk paths or clash oddly in
  // generated URLs.
  if (e.id !== undefined) {
    if (typeof e.id !== 'string' || !/^[a-z0-9-]{1,64}$/.test(e.id)) {
      errors.push({ entry: label, message: `id must be a slug of ≤64 chars [a-z0-9-]` });
    }
  }
  for (const field of ['name', 'city', 'color'] as const) {
    const v = e[field];
    if (v !== undefined && (typeof v !== 'string' || v.length === 0 || v.length > MAX_STRING_FIELD)) {
      errors.push({ entry: label, message: `${field} must be a non-empty string of ≤${MAX_STRING_FIELD} chars` });
    }
  }
  if (e.name === undefined) {
    errors.push({ entry: label, message: 'name is required' });
  }
  const adapter = e.adapter;
  if (adapter === null || typeof adapter !== 'object' || Array.isArray(adapter)) {
    errors.push({ entry: label, message: 'adapter must be an object' });
  } else {
    const a = adapter as Record<string, unknown>;
    if (typeof a.kind !== 'string' || a.kind.length === 0 || a.kind.length > 64) {
      errors.push({ entry: label, message: `adapter.kind must be a non-empty string of ≤64 chars` });
    }
    for (const field of ['baseUrl'] satisfies string[]) {
      const v = a[field];
      if (
        v !== undefined &&
        (typeof v !== 'string' || v.length === 0 || v.length > MAX_URL_LENGTH)
      ) {
        errors.push({ entry: label, message: `adapter.${field} must be a non-empty string of ≤${MAX_URL_LENGTH} chars` });
      }
    }
  }
  return errors;
}

/** Last-known-good sibling path for a custom-cinemas file. */
export function lkgFilePath(filePath: string): string {
  return `${filePath}.lkg`;
}

/**
 * Atomic write: fsync'd temp file in the SAME directory, then rename.
 * On failure the temp file is removed and the caller's file is untouched.
 */
function atomicWrite(filePath: string, data: string): void {
  const dir = path.dirname(filePath);
  const tmp = path.join(dir, `.tmp-custom-cinemas-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
  try {
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeFileSync(fd, data);
      fs.fsyncSync(fd); // durability before the rename makes it visible
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, filePath); // atomic on POSIX — readers see old or new
    try {
      // Best-effort last-known-good copy (crash forensics / manual restore).
      fs.copyFileSync(filePath, lkgFilePath(filePath));
    } catch (err) {
      log.cinemas.warn(`[custom-cinemas] .lkg backup failed: ${String(err)}`);
    }
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* nothing to clean */
    }
    throw err;
  }
}

/**
 * Write the editor's list to the custom-cinemas file and re-register.
 *
 * Passing `entries: []` removes all custom cinemas (file mirrors registry).
 * The save is rejected wholesale (nothing written, registry untouched)
 * if: the input is not an array, there are too many entries, or ANY entry
 * fails structural shape validation — corrupting the last-known-good file
 * with it is impossible. Business-level problems (unknown plugin kind, bad
 * URLs) are still reported per-entry by the registry reload afterwards.
 * Never throws for content problems.
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
  if (entries.length > MAX_CUSTOM_CINEMAS) {
    const message = `saveCustomCinemas: ${entries.length} entries exceeds the ${MAX_CUSTOM_CINEMAS} limit — nothing written`;
    log.cinemas.error(message);
    return {
      written: false,
      reload: { registered: [], errors: [{ entry: 'request', message }] },
    };
  }

  // ── Validate the COMPLETE configuration before committing anything ──
  const structuralErrors: StructuralError[] = [];
  for (let i = 0; i < entries.length; i++) {
    structuralErrors.push(...validateCustomEntryShape(entries[i], i));
  }
  if (structuralErrors.length > 0) {
    for (const err of structuralErrors) {
      log.cinemas.error(`[custom-cinemas] save rejected: ${err.entry} ${err.message}`);
    }
    return {
      written: false,
      reload: { registered: [], errors: structuralErrors },
    };
  }

  try {
    atomicWrite(filePath, JSON.stringify({ cinemas: entries }, null, 2) + '\n');
  } catch (err) {
    const message = `saveCustomCinemas: write failed — ${String(err)}. Previous file untouched.`;
    log.cinemas.error(message);
    return {
      written: false,
      reload: { registered: [], errors: [{ entry: 'request', message }] },
    };
  }
  const reload = loadCustomCinemas(filePath);
  return { written: true, reload };
}
