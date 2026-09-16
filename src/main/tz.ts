// ──────────────────────────────────────────────────────────────────────────
// Force Europe/Paris as the process timezone.
//
// BUG-04 fix: previously this assignment lived at the top of `src/main/index.ts`,
// BELOW the `import` statements. ES module imports are hoisted and evaluated
// before any statement in the module body, so the comment describing the
// assignment as "MUST be set before any code that constructs Dates" was
// describing an invariant the language does not provide. It worked today
// only because no imported module happened to construct a `Date` at module
// scope, but adding a memoised "today" constant to any adapter would have
// silently computed in the host timezone.
//
// Fix — move the assignment into this dedicated side-effect module, and
// import it FIRST from `src/main/index.ts`. ES module imports are
// evaluated in source order, so this guarantees the assignment runs
// before any other module's top-level code.
//
// Long-term preferred fix (not done here): drop the global entirely and
// use `Intl.DateTimeFormat` with explicit `timeZone: 'Europe/Paris'`
// everywhere. The shared `toIsoDay` / `parisHour` helpers already do this.
// ──────────────────────────────────────────────────────────────────────────

process.env.TZ = 'Europe/Paris';
