// ──────────────────────────────────────────────────────────────────────────
// Global test setup — runs before every test file.
//
// We set `process.env.TZ = 'Europe/Paris'` here because some date functions
// in the codebase (e.g. `new Date('2026-09-19T19:45:00')` — no tz designator)
// depend on the host timezone to interpret the timestamp.
//
// In production, `src/main/tz.ts` sets this BEFORE any Date construction.
// In tests, we replicate it here so date-dependent tests are deterministic
// regardless of the host machine's local timezone.
//
// NOTE: Node.js reads TZ at process startup. Setting it at runtime via
// `process.env.TZ = ...` only affects NEW Date objects created after the
// call (and only if the underlying ICU library supports TZ env switching).
// To be safe, we ALSO set it via the vitest config's `env` option.
// ──────────────────────────────────────────────────────────────────────────

// Set TZ as early as possible — affects how `new Date('2026-09-19T19:45:00')`
// interprets the no-tz-designator ISO string.
process.env.TZ = 'Europe/Paris';

// Reset the locale state before each test file (the i18n module is
// module-level state, so tests that switch locale can leak across files).
// We import lazily to avoid circular dependencies in test setup.
beforeEach(async () => {
  const { setLocale, DEFAULT_LOCALE } = await import('../src/shared/i18n');
  setLocale(DEFAULT_LOCALE);
});
