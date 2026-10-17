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
//     - structurally invalid entries → save rejected WHOLESALE: nothing
//       written, previous bytes + registry state intact (review DATA-02)
//     - registry-level problems (unknown kind etc.) → written + reported
//       per-entry (work-in-progress editing stays on disk, registry skips)
//     - atomic write: fsync'd temp + rename, no stray temp files, previous
//       file bytes preserved on rejection, `.lkg` backup refreshed
//     - size caps (≤50 entries, field lengths)
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
  MAX_CUSTOM_CINEMAS,
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

  it('a STRUCTURALLY invalid entry rejects the WHOLE save: nothing written, previous bytes intact', () => {
    saveCustomCinemas(filePath(), [VALID_CUSTOM]); // known-good state first
    const bytesBefore = fs.readFileSync(filePath(), 'utf8');

    const invalid = { id: 'bad', name: 'X' }; // missing adapter entirely
    const { written, reload } = saveCustomCinemas(filePath(), [invalid, VALID_CUSTOM]);
    expect(written).toBe(false);
    expect(reload.registered).toEqual([]);
    expect(reload.errors[0].entry).toBe('cinemas[0]'); // the invalid one is named
    // The registry keeps the previous custom cinema.
    expect(getCustomCinemaIds()).toEqual(['custom-ipc-test']);

    // The file on disk is byte-for-byte the previous (valid) list.
    expect(fs.readFileSync(filePath(), 'utf8')).toBe(bytesBefore);
    // No temp files left behind by the aborted write.
    expect(fs.readdirSync(tmpDir).filter((f) => f.startsWith('.tmp-'))).toEqual([]);
  });

  it('registry-level problems (unknown kind) are still written + reported per-entry', () => {
    const wrongKind = { ...VALID_CUSTOM, id: 'wrong-kind', adapter: { kind: 'no-such-kind', baseUrl: 'https://x.test' } };
    const { written, reload } = saveCustomCinemas(filePath(), [wrongKind]);
    expect(written).toBe(true); // shape is valid — commit it
    expect(reload.registered).toEqual([]); // registry rejects the kind
    expect(reload.errors).toHaveLength(1);
    // Editing work stays on disk (the UI shows the error against the row).
    expect(readCustomCinemasFile(filePath()).cinemas).toEqual([wrongKind]);
    expect(getCustomCinemaIds()).toEqual([]);
  });

  it('a successful save leaves no stray temp files and refreshes the .lkg backup', () => {
    saveCustomCinemas(filePath(), [VALID_CUSTOM]);
    expect(fs.readdirSync(tmpDir).filter((f) => f.startsWith('.tmp-'))).toEqual([]);
    const lkg = fs.readFileSync(path.join(tmpDir, 'custom-cinemas.json.lkg'), 'utf8');
    expect(lkg).toBe(fs.readFileSync(filePath(), 'utf8'));
  });

  it('an oversized field or id fails structural validation (length caps)', () => {
    const longName = { ...VALID_CUSTOM, name: 'x'.repeat(201) };
    const { written } = saveCustomCinemas(filePath(), [longName]);
    expect(written).toBe(false);
    expect(fs.existsSync(filePath())).toBe(false); // brand-new dir: nothing created

    const badId = { ...VALID_CUSTOM, id: 'Bad_ID!' };
    expect(saveCustomCinemas(filePath(), [badId]).written).toBe(false);
  });

  it('more than MAX_CUSTOM_CINEMAS entries is rejected wholesale', () => {
    const many = Array.from({ length: MAX_CUSTOM_CINEMAS + 1 }, (_, i) => ({
      ...VALID_CUSTOM,
      id: `max-entry-${i}`,
    }));
    const { written, reload } = saveCustomCinemas(filePath(), many);
    expect(written).toBe(false);
    expect(reload.errors[0].message).toMatch(/exceeds the 50 limit/);
    expect(fs.existsSync(filePath())).toBe(false);
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
