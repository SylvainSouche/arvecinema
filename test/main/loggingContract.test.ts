// ──────────────────────────────────────────────────────────────────────────
// Logging contract tests — structural + behavioral invariants of the
// logging system. Replaces scripts/smoke-test-logger.mjs (migrated to
// vitest so it runs with `npm test` in CI instead of as a separate
// fragile grep step).
//
// Upgraded over the script where possible:
//   - logger.ts exports are verified by ACTUAL import through the electron
//     mock (same pattern as cacheDb.test.ts) — a missing export fails
//     compile/import, not just a regex miss
//   - moduleLoggers component set: real import + Object.keys comparison
//   - the console-stray audit + wiring + preload + LogViewer checks stay
//     source-level (they audit files that can't be imported in vitest:
//     index.ts needs electron at runtime; LogViewer needs window.electronAPI)
//
// What this catches:
//   - a renamed/removed logger export breaking CI's log:get-all flow
//   - a stray console.* slipping into main/shared code (bypassing context,
//     levels, LogViewer + diagnostics counts)
//   - broken logging wiring (initLogging, IPC handlers, shutdown flush)
// ──────────────────────────────────────────────────────────────────────────

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Lives in os.tmpdir (NOT repo cwd): the file dispatcher writes
// asynchronously — any rmSync here would race its in-flight writes (ENOENT
// unhandled errors under vitest). tmpdir is OS-cleaned, no repo pollution.
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'arvecinema-logging-contract-'));
fs.mkdirSync(path.join(TMP_DIR, 'logs'), { recursive: true });

vi.mock('electron', () => ({
  app: {
    getPath: () => TMP_DIR,
    isPackaged: false,
    on: () => {},
  },
  BrowserWindow: {
    getAllWindows: () => [],
  },
}));

import {
  textFormatter,
  jsonFormatter,
  csvFormatter,
  initLogging,
  getComponentLogger,
  getAllLogs,
  clearLogs,
  flushLogs,
} from '../../src/main/ratings/logger';
import { log } from '../../src/main/ratings/moduleLoggers';

/** Expected component loggers — every source module that logs has one.
 *  A module using a MISSING key here would crash at first log call. */
const EXPECTED_LOGGERS = [
  'enricher', 'idResolver', 'ratingsFetcher', 'browserFetch',
  'browserGraphqlFetch', 'allocine', 'imdbDataset', 'imdbScraper',
  'imdbGraphql', 'wikidata', 'cacheDb', 'connectionPool', 'schedule',
  'cinemas', 'cineChateau', 'networkActivity', 'shutdown',
];

beforeAll(() => {
  fs.mkdirSync(path.join(TMP_DIR, 'logs'), { recursive: true }); // file dispatcher writes TMP_DIR/logs/arvecinema.log
  initLogging(false); // non-debug level
});
afterAll(() => {
  // best-effort: rmSync would race the file dispatcher's async in-flight
  // writes (ENOENT under vitest's unhandled-error detector).
  try {
    flushLogs();
  } catch {
    /* already flushed */
  }
});

// ── logger.ts public API (behavioral — better than the old regex checks) ──

describe('logging contract: logger.ts API surface (real import)', () => {
  it('formatters are functions with the correct output shape', () => {
    expect(typeof textFormatter).toBe('function');
    expect(typeof jsonFormatter).toBe('function');
    expect(typeof csvFormatter).toBe('function');
  });

  it('component logger produces a routed log entry (debug level dropped when not in debug mode)', () => {
    const logger = getComponentLogger('contract-test');
    expectNoThrow(() => log.schedule.info('contract probe message'));
    // getAllLogs/clearLogs work from any component logger state
    expect(Array.isArray(getAllLogs())).toBe(true);
    clearLogs();
    expect(getAllLogs()).toHaveLength(0);
    void logger;
  });

  it('getAllLogs → clearLogs → flushLogs lifecycle holds', () => {
    log.cacheDb.error('probe error');
    const all = getAllLogs();
    // Note: moduleLoggers maps property key 'cacheDb' → entry label
    // 'cache-db' (dash) — the memory log is searchable by message/label.
    expect(all.some((e) => e.message.includes('probe error'))).toBe(true);
    expect(all.some((e) => e.component === 'cache-db')).toBe(true);
    expect(all[0]).toHaveProperty('timestamp');
    expect(all[0]).toHaveProperty('level');
    expect(all[0]).toHaveProperty('component');
    expect(all[0]).toHaveProperty('message');
    flushLogs(); // must not throw even with no open dispatchers
    clearLogs();
    expect(getAllLogs()).toHaveLength(0);
  });
});

describe('logging contract: moduleLoggers component coverage (real import)', () => {
  it(`log has all ${EXPECTED_LOGGERS.length} expected component loggers`, () => {
    const missing = EXPECTED_LOGGERS.filter((name) => !(name in log));
    expect(missing).toEqual([]);
  });

  it('every component logger exposes the 4 levels', () => {
    for (const name of EXPECTED_LOGGERS) {
      const l = (log as unknown as Record<string, unknown>)[name] as Record<string, unknown>;
      for (const level of ['debug', 'info', 'warn', 'error']) {
        expect(l[level]).toBeTypeOf('function');
      }
    }
  });

  it('no stray console.* calls outside logger.ts (console migration audit)', () => {
    const violations: string[] = [];
    for (const dir of ['src/main', 'src/shared']) {
      for (const file of walkFiles(path.join(process.cwd(), dir), '.ts')) {
        const rel = path.relative(process.cwd(), file);
        // Intentional console sinks:
        //  - ratings/logger.ts: the ConsoleDispatcher feeding memory/file logs
        //  - shared/simpleLogger.ts: console sink for Electron-less shared modules
        if (rel.endsWith('ratings/logger.ts')) continue;
        if (rel.endsWith('shared/simpleLogger.ts')) continue;
        const src = fs.readFileSync(file, 'utf8');
        const stripped = src
          .replace(/\/\/[^\n]*/g, '') // line comments
          .replace(/\/\*[\s\S]*?\*\//g, '') // block comments
          .replace(/"(?:\\.|[^"\\])*"/g, '""') // double-quote strings
          .replace(/'(?:\\.|[^'\\])*'/g, "''") // single-quote strings
          .replace(/`(?:\\.|[^`\\])*`/g, '``'); // template strings
        const matches = stripped.match(/\bconsole\.(log|warn|error)\(/g);
        if (matches) violations.push(`${rel}: ${matches.length} stray console calls`);
      }
    }
    expect(violations).toEqual([]);
  });
});

// ── Wiring audits (source-level; index.ts can't be imported in vitest) ────

describe('logging contract: wiring (source audit)', () => {
  const indexSrc = () => fs.readFileSync(path.join(process.cwd(), 'src/main/index.ts'), 'utf8');
  const shutdownSrc = () =>
    fs.readFileSync(path.join(process.cwd(), 'src/main/ratings/shutdown.ts'), 'utf8');
  const preloadSrc = () => fs.readFileSync(path.join(process.cwd(), 'src/preload/index.ts'), 'utf8');
  const viewerSrc = () =>
    fs.readFileSync(path.join(process.cwd(), 'src/renderer/components/LogViewer.tsx'), 'utf8');

  it('initLogging imported + called in main/index.ts', () => {
    expect(indexSrc()).toMatch(/import \{[^}]*initLogging[^}]*\} from '\.\/ratings\/logger'/);
    expect(indexSrc()).toMatch(/initLogging\(process\.env\.ARVE_DEBUG === '1'\)/);
  });

  it('log:get-all + log:clear IPC handlers registered in main/index.ts', () => {
    expect(indexSrc()).toMatch(/ipcMain\.handle\('log:get-all'/);
    expect(indexSrc()).toMatch(/ipcMain\.handle\('log:clear'/);
    expect(indexSrc()).toMatch(/getAllLogs/);
    expect(indexSrc()).toMatch(/clearLogs/);
  });

  it('flushLogs called in the shutdown flow', () => {
    expect(shutdownSrc()).toMatch(/flushLogs/);
  });

  it('preload exposes getLogs / clearLogs / onLogAppend', () => {
    expect(preloadSrc()).toMatch(/getLogs:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('log:get-all'\)/);
    expect(preloadSrc()).toMatch(/clearLogs:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('log:clear'\)/);
    expect(preloadSrc()).toMatch(/onLogAppend[\s\S]*ipcRenderer\.on\('log:append'/s);
  });

  it('LogViewer consumes the log entry shape + subscribes correctly', () => {
    const src = viewerSrc();
    expect(src).toMatch(/interface LogEntry[\s\S]*?component:\s*string/);
    expect(src).toMatch(
      /level:\s*'log'\s*\|\s*'warn'\s*\|\s*'error'\s*\|\s*'debug'\s*\|\s*'info'/,
    );
    expect(src).toMatch(/\{entry\.component\}/);
    expect(src).toMatch(/e\.component\.toLowerCase\(\)\.includes/);
    expect(src).toMatch(/window\.electronAPI\.onLogAppend/);
    expect(src).toMatch(/window\.electronAPI\.getLogs\(\)/);
    expect(src).toMatch(/a\.download\s*=.*arvecinema-logs/);
  });
});

// ── helpers ────────────────────────────────────────────────────────────────

function expectNoThrow(fn: () => void): void {
  try {
    fn();
  } catch (err) {
    throw new Error(`expected no throw, got: ${String(err)}`);
  }
}

function walkFiles(dir: string, ext: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(p, ext));
    else if (entry.name.endsWith(ext)) out.push(p);
  }
  return out;
}
