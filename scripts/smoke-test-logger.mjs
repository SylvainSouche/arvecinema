// Smoke test for the logger module — verifies the public API surface
// matches what callers expect. Run via: node scripts/smoke-test-logger.mjs
//
// We can't actually exercise runtime behavior here because logger.ts
// imports from 'electron' which isn't available outside Electron runtime.
// Instead we verify the source structure: all expected exports exist,
// all expected methods exist, and all moduleLoggers keys are present.

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const loggerSrc = fs.readFileSync(
  path.join(root, 'src/main/ratings/logger.ts'),
  'utf8',
);

const moduleLoggersSrc = fs.readFileSync(
  path.join(root, 'src/main/ratings/moduleLoggers.ts'),
  'utf8',
);

const checks = [
  ['exports LogLevel type', /export type LogLevel = /],
  ['exports LogEntry interface', /export interface LogEntry/],
  ['exports Formatter type', /export type Formatter = /],
  ['exports LogDispatcher interface', /export interface LogDispatcher/],
  ['exports textFormatter', /export const textFormatter/],
  ['exports jsonFormatter', /export const jsonFormatter/],
  ['exports csvFormatter', /export const csvFormatter/],
  ['exports createConsoleDispatcher', /export function createConsoleDispatcher/],
  ['exports createMemoryDispatcher', /export function createMemoryDispatcher/],
  ['exports createFileDispatcher', /export function createFileDispatcher/],
  ['exports initLogging', /export function initLogging/],
  ['exports getLogger', /export function getLogger/],
  ['exports getComponentLogger', /export function getComponentLogger/],
  ['exports getAllLogs', /export function getAllLogs/],
  ['exports clearLogs', /export function clearLogs/],
  ['exports flushLogs', /export function flushLogs/],
  ['Logger class has debug method', /debug\(component: string, message: string\)/],
  ['Logger class has info method', /info\(component: string, message: string\)/],
  ['Logger class has warn method', /warn\(component: string, message: string\)/],
  ['Logger class has error method', /error\(component: string, message: string\)/],
  ['Logger class has addDispatcher', /addDispatcher\(d: LogDispatcher\)/],
  ['Logger class has setLevel', /setLevel\(level: LogLevel\)/],
  ['Logger class has getMemoryEntries', /getMemoryEntries\(\)/],
  ['Logger class has clearMemory', /clearMemory\(\)/],
  ['Logger class has flush', /flush\(\): void/],
];

let allOk = true;
console.log('── logger.ts ──────────────────────────────────────────────');
for (const [name, regex] of checks) {
  const ok = regex.test(loggerSrc);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) allOk = false;
}

console.log('\n── moduleLoggers.ts ───────────────────────────────────────');
const expectedLoggers = [
  'enricher', 'idResolver', 'ratingsFetcher', 'browserFetch',
  'browserGraphqlFetch', 'allocine', 'imdbDataset', 'imdbScraper',
  'imdbGraphql', 'wikidata', 'cacheDb', 'connectionPool', 'schedule',
  'cinemas', 'cineChateau', 'networkActivity', 'shutdown',
];
for (const name of expectedLoggers) {
  const exists = new RegExp(`\\b${name}:\\s+getComponentLogger\\(`).test(moduleLoggersSrc);
  console.log(`  ${exists ? 'PASS' : 'FAIL'}  log.${name} exported`);
  if (!exists) allOk = false;
}

// Verify no console.* calls remain in main process (except logger.ts)
console.log('\n── console call migration audit ──────────────────────────');
const mainSrc = path.join(root, 'src/main');
const sharedSrc = path.join(root, 'src/shared');

function walk(dir, ext) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(p, ext));
    else if (entry.name.endsWith(ext)) out.push(p);
  }
  return out;
}

const tsFiles = [...walk(mainSrc, '.ts'), ...walk(sharedSrc, '.ts')];
let strayCount = 0;
for (const file of tsFiles) {
  const rel = path.relative(root, file);
  if (rel.endsWith('ratings/logger.ts')) continue; // legit: console dispatcher
  const src = fs.readFileSync(file, 'utf8');
  // Strip comments + string literals to avoid false positives
  const stripped = src
    .replace(/\/\/[^\n]*/g, '')      // line comments
    .replace(/\/\*[\s\S]*?\*\//g, '') // block comments
    .replace(/"(?:\\.|[^"\\])*"/g, '""') // double-quote strings
    .replace(/'(?:\\.|[^'\\])*'/g, "''") // single-quote strings
    .replace(/`(?:\\.|[^`\\])*`/g, '``'); // template strings
  const matches = stripped.match(/\bconsole\.(log|warn|error)\(/g);
  if (matches) {
    console.log(`  FAIL  ${rel}: ${matches.length} stray console calls`);
    strayCount += matches.length;
  }
}
if (strayCount === 0) {
  console.log('  PASS  no stray console.* calls outside logger.ts');
} else {
  allOk = false;
}

// Verify wiring: initLogging is called from main/index.ts
console.log('\n── wiring ────────────────────────────────────────────────');
const indexSrc = fs.readFileSync(
  path.join(root, 'src/main/index.ts'),
  'utf8',
);
const wiringChecks = [
  ['initLogging imported in main/index.ts', /import \{[^}]*initLogging[^}]*\} from '\.\/ratings\/logger'/],
  ['initLogging called in whenReady', /initLogging\(process\.env\.ARVE_DEBUG === '1'\)/],
  ['log:get-all IPC handler registered', /ipcMain\.handle\('log:get-all'/],
  ['log:clear IPC handler registered', /ipcMain\.handle\('log:clear'/],
  ['getAllLogs imported in main/index.ts', /getAllLogs/],
  ['clearLogs imported in main/index.ts', /clearLogs/],
  ['flushLogs called in shutdown.ts', /flushLogs\(\)/],
];
for (const [name, regex] of wiringChecks) {
  const ok = regex.test(indexSrc) || regex.test(
    fs.readFileSync(path.join(root, 'src/main/ratings/shutdown.ts'), 'utf8'),
  );
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) allOk = false;
}

// Verify preload exposes log APIs
console.log('\n── preload ───────────────────────────────────────────────');
const preloadSrc = fs.readFileSync(
  path.join(root, 'src/preload/index.ts'),
  'utf8',
);
const preloadChecks = [
  ['exposes getLogs', /getLogs:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('log:get-all'\)/],
  ['exposes clearLogs', /clearLogs:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('log:clear'\)/],
  ['exposes onLogAppend with log:append channel', /onLogAppend.*ipcRenderer\.on\('log:append'/s],
  ['LogEntry type includes component', /component:\s*string/],
];
for (const [name, regex] of preloadChecks) {
  const ok = regex.test(preloadSrc);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) allOk = false;
}

// Verify LogViewer consumes the new shape
console.log('\n── LogViewer ─────────────────────────────────────────────');
const viewerSrc = fs.readFileSync(
  path.join(root, 'src/renderer/components/LogViewer.tsx'),
  'utf8',
);
const viewerChecks = [
  ['LogEntry interface includes component', /interface LogEntry[\s\S]*?component:\s*string/],
  ['LogEntry interface includes debug|info levels', /level:\s*'log'\s*\|\s*'warn'\s*\|\s*'error'\s*\|\s*'debug'\s*\|\s*'info'/],
  ['Renders entry.component', /\{entry\.component\}/],
  ['Filters by componentFilter', /e\.component\.toLowerCase\(\)\.includes/],
  ['Subscribes via onLogAppend', /window\.electronAPI\.onLogAppend/],
  ['Loads initial via getLogs', /window\.electronAPI\.getLogs\(\)/],
  ['Exports filtered logs to .txt', /a\.download\s*=.*arvecinema-logs/],
];
for (const [name, regex] of viewerChecks) {
  const ok = regex.test(viewerSrc);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) allOk = false;
}

console.log(allOk ? '\n=== ALL SMOKE TESTS PASSED ===' : '\n=== SOME CHECKS FAILED ===');
process.exit(allOk ? 0 : 1);
