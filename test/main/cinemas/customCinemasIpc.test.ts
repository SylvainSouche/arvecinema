// ──────────────────────────────────────────────────────────────────────────
// customCinemasIpc tests — file I/O + save/reload helpers backing the
// About panel → Cinemas settings tab (src/main/cinemas/customCinemasIpc.ts).
//
// Covers:
//   readCustomCinemasFile:
//     - missing file → clean empty state (exists=false)
//     - existing file → raw entries returned as-is (form is editable)
//     - malformed JSON → empty state, no crash
//     - wrong shape (no 'cinemas' array) → empty list
//   saveCustomCinemas:
//     - writes the file (pretty JSON) then re-registers through the SAME
//       validation path as startup (loadCustomCinemas)
//     - valid entries register; invalid ones come back as errors for the UI
//     - saving [] clears the custom set
//     - non-array input is rejected WITHOUT writing (never corrupts disk)
//     - the file persists so the NEXT app startup picks the list up
//
// Drives the real registry (same process), restored via
// unregisterCustomCinemas after each test — no electron needed.
// ──────────────────────────────────────────────────────────────────────────

import { beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  readCustomCinemasFile,
  saveCustomCinemas,
} from '../../../src/main/cinemas/customCinemasIpc';
import {
  CINEMAS,
  getCustomCinemaIds,
  loadCustomCinemas,
  unregisterCustomCinemas,
} from '../../../src/main/cinemas/registry';

const VALID_CUSTOM = {
  id: 'custom-ipc-test',
  name: 'Cinéma IPC Test',
  city: 'Nowhere',
  color: '#f97316',
  adapter: { kind: 'example', baseUrl: 'https://example.com' },
};

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arvecinema-custom-ipc-test-'));
});

afterEach(() => {
  unregisterCustomCinemas();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function filePath(): string {
  return path.join(tmpDir, 'custom-cinemas.json');
}

// ── readCustomCinemasFile ──────────────────────────────────────────────────

describe('readCustomCinemasFile', () => {
  it('a missing file yields a clean empty state', () => {
    const read = readCustomCinemasFile(filePath());
    expect(read).toEqual({ path: filePath(), exists: false, cinemas: [] });
  });

  it('an existing file returns its raw entries (form is editable as-is)', () => {
    fs.writeFileSync(filePath(), JSON.stringify({ cinemas: [VALID_CUSTOM, { garbage: true }] }));
    const read = readCustomCinemasFile(filePath());
    expect(read.exists).toBe(true);
    expect(read.cinemas).toHaveLength(2);
    expect(read.cinemas[0]).toEqual(VALID_CUSTOM);
  });

  it('malformed JSON yields an empty editable list, no crash', () => {
    fs.writeFileSync(filePath(), '{ corrupted !!!');
    const read = readCustomCinemasFile(filePath());
    expect(read.exists).toBe(false); // treated as absent for the form
    expect(read.cinemas).toEqual([]);
  });

  it("a file without a 'cinemas' array yields an empty list", () => {
    fs.writeFileSync(filePath(), JSON.stringify({ cinema: [] }));
    const read = readCustomCinemasFile(filePath());
    expect(read.cinemas).toEqual([]);
  });
});

// ── saveCustomCinemas ──────────────────────────────────────────────────────

describe('saveCustomCinemas', () => {
  it('writes the file and registers the valid entries', () => {
    const { written, reload } = saveCustomCinemas(filePath(), [VALID_CUSTOM]);
    expect(written).toBe(true);
    expect(reload.registered).toEqual(['custom-ipc-test']);
    expect(reload.errors).toEqual([]);
    expect(getCustomCinemaIds()).toEqual(['custom-ipc-test']);
    expect(CINEMAS.map((c) => c.id)).toContain('custom-ipc-test');
  });

  it('invalid entries are written but rejected with errors (per-entry report)', () => {
    const invalid = { id: 'bad', name: 'X' }; // missing city/color/adapter
    const { written, reload } = saveCustomCinemas(filePath(), [invalid, VALID_CUSTOM]);
    expect(written).toBe(true);
    expect(reload.registered).toEqual(['custom-ipc-test']);
    expect(reload.errors).toHaveLength(1);
    expect(reload.errors[0].entry).toBe('cinemas[0]');
    // The registry keeps only the valid one.
    expect(getCustomCinemaIds()).toEqual(['custom-ipc-test']);
  });

  it('saving [] clears the custom registry (remove-all via file)', () => {
    saveCustomCinemas(filePath(), [VALID_CUSTOM]);
    expect(getCustomCinemaIds()).toEqual(['custom-ipc-test']);

    saveCustomCinemas(filePath(), []);
    expect(getCustomCinemaIds()).toEqual([]);
    expect(CINEMAS.map((c) => c.id)).not.toContain('custom-ipc-test');
  });

  it('a non-array input is rejected WITHOUT writing (disk never corrupted)', () => {
    saveCustomCinemas(filePath(), [VALID_CUSTOM]); // valid state first

    const { written, reload } = saveCustomCinemas(filePath(), 'not-an-array' as unknown);
    expect(written).toBe(false);
    expect(reload.errors[0].message).toMatch(/expected an array/);
    // Previous state intact.
    expect(getCustomCinemaIds()).toEqual(['custom-ipc-test']);

    // And the file on disk still holds the previous (valid) list.
    const read = readCustomCinemasFile(filePath());
    expect(read.cinemas).toEqual([VALID_CUSTOM]);
  });

  it('the written file persists so the NEXT startup reloads the same list', () => {
    saveCustomCinemas(filePath(), [VALID_CUSTOM]);
    // Simulate restart: wipe runtime registrations, re-load like main does.
    unregisterCustomCinemas();
    const result = loadCustomCinemas(filePath());
    expect(result.registered).toEqual(['custom-ipc-test']);
    expect(getCustomCinemaIds()).toEqual(['custom-ipc-test']);
  });
});
