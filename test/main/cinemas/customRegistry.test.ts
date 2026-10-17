// ──────────────────────────────────────────────────────────────────────────
// Custom registry tests — userData-driven runtime cinema instances.
//
// Covers `loadCustomCinemas` / `unregisterCustomCinemas` / `getCustomCinemaIds`
// in `src/main/cinemas/registry.ts` — the runtime (non-bundled) half of the
// drop-in cinema architecture.
//
// What this catches:
//   - JSON file handling: missing file, malformed JSON, wrong shape
//   - validation parity: custom entries must pass the SAME shape checks and
//     plugin `validateConfig` as bundled instances
//   - namespace protection: a custom id colliding with a bundled id is
//     rejected (users cannot hijack/override builtin cinemas)
//   - atomic replacement: a fully-invalid reload must not wipe the previous
//     custom set; a partial reload registers the valid entries
//   - removal: replacing the file removes previously-registered customs
//   - leak safety: getCinemaInfos() exposes metadata only (no adapter)
//
// What this misses:
//   - e2e-level UI rendering (covered by test/e2e/custom-cinema.e2e.ts)
//   - real network adapters (the 'example' canary plugin is offline-safe)
// ──────────────────────────────────────────────────────────────────────────

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CINEMAS, CINEMA_INFOS, getCinemaInfos, getCustomCinemaIds, loadCustomCinemas, unregisterCustomCinemas } from '../../../src/main/cinemas/registry';

// The 'example' canary plugin: offline-safe, empty schedule — no network.
const VALID_CUSTOM = {
  id: 'custom-test',
  name: 'Cinéma Test Local',
  city: 'Nowhere',
  color: '#f97316',
  adapter: { kind: 'example', baseUrl: 'https://example.com' },
};

let tmpDir: string;

function writeCustomFile(entries: unknown): string {
  fs.writeFileSync(path.join(tmpDir, 'custom-cinemas.json'), JSON.stringify(entries));
  return path.join(tmpDir, 'custom-cinemas.json');
}

function filePath(): string {
  return path.join(tmpDir, 'custom-cinemas.json');
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arvecinema-custom-registry-test-'));
});

afterEach(() => {
  // Restore the registry to builtin-only state — tests share the module.
  unregisterCustomCinemas();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const builtinIds = (): string[] => CINEMAS.filter((c) => !getCustomCinemaIds().includes(c.id)).map((c) => c.id);

// ── File handling ──────────────────────────────────────────────────────────

describe('loadCustomCinemas — file handling', () => {
  it('a missing file is a clean no-op', () => {
    const before = CINEMAS.map((c) => c.id);
    const result = loadCustomCinemas(filePath());
    expect(result.registered).toEqual([]);
    expect(result.errors).toEqual([]);
    expect(getCustomCinemaIds()).toEqual([]);
    expect(CINEMAS.map((c) => c.id)).toEqual(before);
  });

  it('malformed JSON reports an error and leaves the registry untouched', () => {
    fs.writeFileSync(filePath(), '{ this is not valid json !!!');
    const before = CINEMAS.map((c) => c.id);
    const result = loadCustomCinemas(filePath());
    expect(result.registered).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].message).toMatch(/not valid JSON/i);
    expect(getCustomCinemaIds()).toEqual([]);
    expect(CINEMAS.map((c) => c.id)).toEqual(before);
  });

  it("a file without a 'cinemas' array is rejected with a clear error", () => {
    const file = writeCustomFile({ cinema: [VALID_CUSTOM] }); // wrong key
    const result = loadCustomCinemas(file);
    expect(result.registered).toEqual([]);
    expect(result.errors[0].message).toMatch(/'cinemas' array/);
    expect(getCustomCinemaIds()).toEqual([]);
  });
});

// ── Registration happy path ────────────────────────────────────────────────

describe('loadCustomCinemas — registration', () => {
  it('registers a valid custom cinema into CINEMAS', () => {
    const before = CINEMAS.map((c) => c.id);
    const file = writeCustomFile({ cinemas: [VALID_CUSTOM] });
    const result = loadCustomCinemas(file);

    expect(result.registered).toEqual(['custom-test']);
    expect(result.errors).toEqual([]);
    expect(getCustomCinemaIds()).toEqual(['custom-test']);
    expect(CINEMAS.map((c) => c.id)).toContain('custom-test');
    expect(CINEMAS.length).toBe(before.length + 1);
  });

  it('the custom cinema has a working adapter (offline example plugin)', () => {
    writeCustomFile({ cinemas: [VALID_CUSTOM] });
    loadCustomCinemas(filePath());
    const custom = CINEMAS.find((c) => c.id === 'custom-test')!;
    expect(custom.name).toBe(VALID_CUSTOM.name);
    expect(typeof custom.adapter.fetchSchedule).toBe('function');
  });

  it('getCinemaInfos exposes the custom metadata WITHOUT the adapter', () => {
    writeCustomFile({ cinemas: [VALID_CUSTOM] });
    loadCustomCinemas(filePath());
    const infos = getCinemaInfos();
    const info = infos.find((i) => i.id === 'custom-test');
    expect(info).toBeDefined();
    expect(info!.name).toBe(VALID_CUSTOM.name);
    expect((info as unknown as Record<string, unknown>).adapter).toBeUndefined();
  });

  it('the bundled CINEMA_INFOS snapshot stays builtin-only (no custom leak)', () => {
    // CINEMA_INFOS is the module-load snapshot — builtin-only by contract;
    // the live renderer view is getCinemaInfos(), not this.
    writeCustomFile({ cinemas: [VALID_CUSTOM] });
    loadCustomCinemas(filePath());
    expect(CINEMAS.map((c) => c.id)).toContain('custom-test');
    expect(CINEMA_INFOS.find((i) => i.id === 'custom-test')).toBeUndefined();
  });
});

// ── Validation parity with bundled instances ───────────────────────────────

describe('loadCustomCinemas — validation parity', () => {
  it('rejects entries missing required fields, registers the valid ones', () => {
    const file = writeCustomFile({
      cinemas: [
        { id: 'no-city', name: 'X', color: '#000000', adapter: { kind: 'example', baseUrl: 'u' } },
        VALID_CUSTOM,
      ],
    });
    const result = loadCustomCinemas(file);
    expect(result.registered).toEqual(['custom-test']);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].entry).toBe('cinemas[0]');
    expect(result.errors[0].message).toMatch(/city/);
    expect(getCustomCinemaIds()).toEqual(['custom-test']);
  });

  it('rejects an unknown adapter kind with the known kinds in the message', () => {
    const file = writeCustomFile({
      cinemas: [
        { id: 'bad-kind', name: 'X', city: 'Y', color: '#111111', adapter: { kind: 'does-not-exist' } },
        VALID_CUSTOM,
      ],
    });
    const result = loadCustomCinemas(file);
    expect(result.registered).toEqual(['custom-test']);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].message).toMatch(/unknown adapter kind/);
    expect(result.errors[0].message).toMatch(/boxofficeapi/); // a registered kind
    expect(getCustomCinemaIds()).toEqual(['custom-test']);
  });

  it('rejects entries failing plugin validateConfig (example: empty baseUrl)', () => {
    const file = writeCustomFile({
      cinemas: [
        {
          id: 'bad-config',
          name: 'X',
          city: 'Y',
          color: '#222222',
          adapter: { kind: 'example', baseUrl: '' },
        },
      ],
    });
    const result = loadCustomCinemas(file);
    expect(result.registered).toEqual([]);
    expect(result.errors[0].entry).toBe('custom:bad-config');
    expect(result.errors[0].message).toMatch(/config\.baseUrl/); // plugin's own message
    expect(result.errors[0].message).toMatch(/non-empty string/);
    expect(getCustomCinemaIds()).toEqual([]);
  });

  it("accepts (ignores) a testOnly flag on a runtime custom entry", () => {
    const file = writeCustomFile({
      cinemas: [{ ...VALID_CUSTOM, testOnly: false }],
    });
    const result = loadCustomCinemas(file);
    // A user-authored runtime instance is intentional — always registered.
    expect(result.registered).toEqual(['custom-test']);
  });
});

// ── Namespace + duplicate protection ───────────────────────────────────────

describe('loadCustomCinemas — namespace protection', () => {
  it('a custom id colliding with a bundled id is rejected, builtin untouched', () => {
    const hijack = { ...VALID_CUSTOM, id: 'mont-blanc', name: 'Faux Mont-Blanc' };
    const file = writeCustomFile({ cinemas: [hijack, VALID_CUSTOM] });
    const result = loadCustomCinemas(file);

    expect(result.registered).toEqual(['custom-test']);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].message).toMatch(/duplicate cinema id "mont-blanc"/);

    const montBlanc = CINEMAS.find((c) => c.id === 'mont-blanc')!;
    expect(montBlanc.name).toBe('Ciné Mont-Blanc'); // NOT "Faux Mont-Blanc"
    expect(getCustomCinemaIds()).toEqual(['custom-test']);
  });

  it('a duplicate id within the file registers only the first occurrence', () => {
    const variant = { ...VALID_CUSTOM, name: 'Second Attempt' };
    const file = writeCustomFile({ cinemas: [VALID_CUSTOM, variant] });
    const result = loadCustomCinemas(file);

    expect(result.registered).toEqual(['custom-test']);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].entry).toBe('cinemas[1]');

    const names = CINEMAS.filter((c) => c.id === 'custom-test').map((c) => c.name);
    expect(names).toEqual([VALID_CUSTOM.name]);
  });
});

// ── Replacement semantics (add/remove via file) ────────────────────────────

describe('loadCustomCinemas — replacement semantics', () => {
  it('reloading replaces the custom set: removal works via file edit', () => {
    writeCustomFile({ cinemas: [VALID_CUSTOM] });
    loadCustomCinemas(filePath());
    expect(getCustomCinemaIds()).toEqual(['custom-test']);

    const second = { ...VALID_CUSTOM, id: 'custom-test-2', name: 'Cinéma Test 2' };
    writeCustomFile({ cinemas: [second] });
    const result = loadCustomCinemas(filePath());

    expect(result.registered).toEqual(['custom-test-2']);
    expect(getCustomCinemaIds()).toEqual(['custom-test-2']);
    expect(CINEMAS.map((c) => c.id)).not.toContain('custom-test');
    expect(CINEMAS.map((c) => c.id)).toContain('custom-test-2');
  });

  it('a fully-invalid (but well-formed) file replaces the set with nothing', () => {
    // World-state semantics: the file MIRRORS the custom registry. An empty
    // or all-invalid cinemas array = "I want no custom cinemas".
    writeCustomFile({ cinemas: [VALID_CUSTOM] });
    loadCustomCinemas(filePath());
    expect(getCustomCinemaIds()).toEqual(['custom-test']);

    writeCustomFile({ cinemas: [{ broken: true }] });
    const result = loadCustomCinemas(filePath());

    expect(result.registered).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(getCustomCinemaIds()).toEqual([]);
    expect(CINEMAS.map((c) => c.id)).not.toContain('custom-test');
  });

  it('a malformed JSON file can never wipe the previous custom set', () => {
    // The corruption guard: unreadable file → previous customs survive.
    writeCustomFile({ cinemas: [VALID_CUSTOM] });
    loadCustomCinemas(filePath());
    expect(getCustomCinemaIds()).toEqual(['custom-test']);

    fs.writeFileSync(filePath(), '{ corrupted !!!');
    const result = loadCustomCinemas(filePath());
    expect(result.registered).toEqual([]);
    expect(getCustomCinemaIds()).toEqual(['custom-test']);
  });

  it('unregisterCustomCinemas restores the builtin-only registry', () => {
    const before = builtinIds();
    writeCustomFile({ cinemas: [VALID_CUSTOM] });
    loadCustomCinemas(filePath());
    expect(CINEMAS.length).toBe(before.length + 1);

    unregisterCustomCinemas();
    expect(getCustomCinemaIds()).toEqual([]);
    expect(CINEMAS.map((c) => c.id)).toEqual(before);
  });
});
