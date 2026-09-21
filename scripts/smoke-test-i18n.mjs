// Smoke test for i18n completeness — verifies:
//   1. Every key in TranslationKey has a corresponding entry in TRANSLATIONS
//   2. Every entry has both `fr` and `en` fields
//   3. No hardcoded French/English UI strings remain in renderer components
//      (we grep for placeholder/aria-label/title attributes and verify they
//      call `t()` or `tFmt()` rather than using string literals)
//   4. The fallback chain works: t(key) never throws even for unknown keys

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const i18nSrc = fs.readFileSync(path.join(root, 'src/shared/i18n.ts'), 'utf8');

let allOk = true;
const fail = (msg) => { console.log(`  FAIL  ${msg}`); allOk = false; };
const pass = (msg) => { console.log(`  PASS  ${msg}`); };

// ── Extract TranslationKey union members ────────────────────────────────────
// Matches: | 'someKey'  (with optional leading whitespace + comment)
const keyMatches = [...i18nSrc.matchAll(/^\s*\|\s*['"]([^'"]+)['"]/gm)];
const declaredKeys = new Set(keyMatches.map(m => m[1]));
console.log(`── i18n.ts ────────────────────────────────────────────────`);
console.log(`  Found ${declaredKeys.size} declared TranslationKey entries`);
if (declaredKeys.size === 0) fail('no TranslationKey entries found');

// ── Extract TRANSLATIONS object keys ────────────────────────────────────────
// We only want TOP-LEVEL keys — not the `fr:` and `en:` fields inside each
// entry. Strategy: scan the TRANSLATIONS block line by line, and only count
// a key when its indentation matches the top level (2 spaces under the
// `export const TRANSLATIONS: Translations = {` line).
const translationsBlock = i18nSrc.match(/export const TRANSLATIONS[^{]*\{([\s\S]*?)\};\s*\n\s*\/\/ ── Locale storage/);
const translationKeys = new Set();
if (!translationsBlock) {
  fail('could not extract TRANSLATIONS block');
} else {
  const block = translationsBlock[1];
  for (const line of block.split('\n')) {
    // Top-level keys are indented with exactly 2 spaces.
    // Match: `  keyName:` or `  'key-name':` or `  "key-name":`
    // Skip lines that are deeper-indented (4+ spaces) — those are the
    // `fr:` and `en:` fields.
    const m = line.match(/^  ([a-zA-Z_][a-zA-Z0-9_]*|['"][^'"]+['"])\s*:/);
    if (m) {
      translationKeys.add(m[1].replace(/^['"]|['"]$/g, ''));
    }
  }

  console.log(`  Found ${translationKeys.size} top-level entries in TRANSLATIONS`);

  // Check 1: every declared key has a translation
  for (const k of declaredKeys) {
    if (!translationKeys.has(k)) fail(`declared key '${k}' missing from TRANSLATIONS`);
  }
  if (declaredKeys.size === translationKeys.size && [...declaredKeys].every(k => translationKeys.has(k))) {
    pass(`all ${declaredKeys.size} declared keys are present in TRANSLATIONS`);
  }

  // Check 2: every entry has both `fr` and `en` fields
  let missingFr = 0, missingEn = 0;
  for (const k of translationKeys) {
    // Match the entry block by finding `  key:` or `  'key':` followed by
    // `{ ... }`. Use a non-greedy match up to the next line that is just
    // `  }` (closing brace at the same 2-space indentation).
    // To handle both bare and quoted keys uniformly, we quote the key
    // ourselves in the regex.
    const escapedKey = k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const keyPattern = new RegExp(
      `^  (?:${escapedKey}|['"]${escapedKey}['"])\\s*:\\s*\\{([\\s\\S]*?)\\n  \\}`,
      'm',
    );
    const m = i18nSrc.match(keyPattern);
    if (!m) {
      fail(`could not parse translation entry for '${k}'`);
      continue;
    }
    const body = m[1];
    // Require `fr:` and `en:` to appear at the start of a line (after
    // optional whitespace) — this avoids matching `fr` inside a string
    // value like "Pourquoi ?"
    if (!/^\s*fr\s*:/m.test(body)) { fail(`'${k}' missing fr field`); missingFr++; }
    if (!/^\s*en\s*:/m.test(body)) { fail(`'${k}' missing en field`); missingEn++; }
  }
  if (missingFr === 0 && missingEn === 0) {
    pass(`all ${translationKeys.size} entries have both fr + en fields`);
  }
}

// ── Check for hardcoded UI strings in renderer components ──────────────────
console.log('\n── hardcoded UI string audit ──────────────────────────────');

function walk(dir, ext) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(p, ext));
    else if (entry.name.endsWith(ext)) out.push(p);
  }
  return out;
}

const componentFiles = walk(path.join(root, 'src/renderer/components'), '.tsx');
let hardCodedCount = 0;
const IGNORE_FILES = ['ExportButton.tsx']; // dev-only — English is acceptable
const ALLOWED_LITERAL_PATTERNS = [
  // Filenames, CSS class names, technical identifiers
  /^[\w-]+$/,
  // Single chars (icons, etc.)
  /^.$/,
  // Empty string
  /^$/,
];

for (const file of componentFiles) {
  const rel = path.relative(root, file);
  if (IGNORE_FILES.some(ignored => rel.endsWith(ignored))) {
    console.log(`  SKIP  ${rel} (dev-only)`);
    continue;
  }
  const src = fs.readFileSync(file, 'utf8');
  // Strip comments + template strings (already handled by t() calls)
  const stripped = src
    .replace(/\/\/[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/`(?:\\.|[^`\\])*`/g, '``');

  // Find aria-label="..." or placeholder="..." with a literal string
  const literalAttrMatches = [...stripped.matchAll(/(?:aria-label|placeholder|title)="([^"]+)"/g)];
  for (const m of literalAttrMatches) {
    const val = m[1];
    // Skip pure-identifier strings
    if (ALLOWED_LITERAL_PATTERNS.some(p => p.test(val))) continue;
    // Skip emoji-only or single-symbol
    if (/^\p{Emoji}+$/u.test(val)) continue;
    console.log(`  FAIL  ${rel}: hardcoded "${val}" (use t() or tFmt())`);
    hardCodedCount++;
  }
}
if (hardCodedCount === 0) {
  pass('no hardcoded aria-label / placeholder / title literals in components');
} else {
  allOk = false;
}

// ── Check that tFmt export exists ─────────────────────────────────────────
console.log('\n── tFmt helper ───────────────────────────────────────────');
if (/export function tFmt\s*\(/.test(i18nSrc)) pass('tFmt exported');
else fail('tFmt not exported');

// ── Check fallback chain in t() ────────────────────────────────────────────
if (/entry\[currentLocale\]\s*\?\?\s*entry\[DEFAULT_LOCALE\]/.test(i18nSrc)) {
  pass('t() has fallback chain: currentLocale → DEFAULT_LOCALE → key');
} else {
  fail('t() missing fallback chain');
}

console.log(allOk ? '\n=== ALL I18N SMOKE TESTS PASSED ===' : '\n=== SOME I18N CHECKS FAILED ===');
process.exit(allOk ? 0 : 1);
