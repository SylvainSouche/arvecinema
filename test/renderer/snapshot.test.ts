// ──────────────────────────────────────────────────────────────────────────
// Snapshot tests — UI regression guard rails for the 3 heavyweight
// renderer components (MovieCard, WeekGrid, LogViewer).
//
// Uses `renderToStaticMarkup` (react-dom/server) in the plain Node
// environment — no DOM needed for a static render, no jsdom dependency.
// Effects don't run in a static render, which is exactly what we want for
// layout snapshots: no IPC calls, no timers, no listeners.
//
// What this catches:
//   - accidental restructuring of the card/grid/log layouts
//   - regressions in badge/rating rendering (VF/VO pills, rating colors,
//     blocked/absent states) that pure logic tests can't see
//   - week-grid swimlane geometry changes (hour columns, day strips)
//
// What this misses:
//   - runtime behavior (guess: interactions, auto-scroll, filters) — that
//     is e2e territory (replay fixture suite)
//   - theme differences: CSS variables are never resolved in a static
//     render (they stay as `var(--…)` strings regardless of theme) —
//     intentional: this snapshot layout only, theme is skipped.
//
// Determinism rules (IMPORTANT when updating fixtures):
//   - locale pinned to 'fr' (default) via setLocale — text snapshot stability
//   - timezone pinned below (vi.hoisted, before imports) to Europe/Paris —
//     the app's canonical zone (src/main/index.ts imports ./tz first).
//     CI runs in UTC, which shifted every showtime chip +2h and broke the
//     comparisons.
//   - WeekGrid fixtures use far-future dates (2099-07-XX, fixed weekdays)
//     so month/weekday computations are time-independent
// ──────────────────────────────────────────────────────────────────────────

// Determinism rules (IMPORTANT when updating fixtures):
//   - locale pinned to 'fr' (default) via setLocale — text snapshot stability
//   - timezone pinned to Europe/Paris by vitest.config's `env` (with the
//     `forks` pool so it applies at process birth) — the app's canonical
//     zone; a UTC host would otherwise shift every showtime chip +2h.
//   - WeekGrid fixtures use far-future dates (2099-07-XX, fixed weekdays)
//     so month/weekday computations are time-independent
// ──────────────────────────────────────────────────────────────────────────</think><tool_call>edit<arg_key>newString</arg_key><arg_value>import { describe, it, expect, beforeEach } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MovieCard } from '../../src/renderer/components/MovieCard';
import { WeekGrid } from '../../src/renderer/components/WeekGrid';
import { LogViewer } from '../../src/renderer/components/LogViewer';
import { setLocale, getLocale } from '../../src/shared/i18n';
import type { Movie, Showtime, CinemaInfo } from '../../src/shared/types';

beforeEach(() => {
  if (getLocale() !== 'fr') setLocale('fr');
});

function showtime(day: string, hour: number, tags = ['Localization.Language.French']): Showtime {
  return {
    // Europe/Paris local time, no tz designator (matches the real data shape).
    time: `${day}T${String(Math.floor(hour)).padStart(2, '0')}:${String(Math.round((hour % 1) * 60)).padStart(2, '0')}`,
    hour, // Paris-local float hour, e.g. 18.5 = 18h30
    day, // YYYY-MM-DD in Europe/Paris
    tags,
    cinemaId: 'cinema-chateau',
  };
}

function makeMovie(overrides: Partial<Movie> = {}): Movie {
  return {
    id: '12345',
    cinemaId: 'cinema-chateau',
    title: "Le Comte de Monte-Cristo",
    direction: 'Alexandre de La Patellière',
    casting: 'Pierre Niney, Anamaria Vartolomei',
    synopsis: "Un jeune marin est injustement emprisonné. Escape. Revenge.",
    genres: 'Aventure, Drame',
    release: '2099-07-23',
    runtime: 178,
    hasVF: true,
    hasVO: true,
    showtimes: [
      showtime('2099-07-12', 18.5),
      showtime('2099-07-12', 20.75, ['Localization.Version.Original']),
    ],
    // Ratings populated — the rich-card snapshot
    imdbId: 'tt22084616',
    imdbRating: 7.8,
    imdbVotes: 15200,
    imdbUrl: 'https://www.imdb.com/title/tt22084616/',
    allocinePress: 3.4,
    allocineAudience: 4.1,
    rtStatus: 'ready',
    rtTomatometer: 88,
    rtCertifiedFresh: true,
    ...overrides,
  } as Movie;
}

function makeCinemas(): CinemaInfo[] {
  return [
    { id: 'cinema-chateau', name: 'Cinéma Château Rouge', city: 'Cluses', color: '#e11d48' },
    { id: 'cinevox', name: 'Cinevox', city: 'Chamonix', color: '#3b82f6' },
  ] as CinemaInfo[];
}

// ── MovieCard ─────────────────────────────────────────────────────────────

describe('snapshot: MovieCard', () => {
  it('rich card (poster-less, all ratings, VF+VO, showtimes)', () => {
    const html = renderToStaticMarkup(
      React.createElement(MovieCard, { movie: makeMovie(), cinemas: makeCinemas() }),
    );
    expect(html).toMatchSnapshot();
  });

  it('sparse card (no poster, no ratings, no synopsis, cinema fallback)', () => {
    const sparse = makeMovie({
      poster: undefined,
      synopsis: undefined,
      genres: undefined,
      imdbId: undefined,
      imdbRating: undefined,
      imdbVotes: undefined,
      imdbUrl: undefined,
      allocinePress: undefined,
      allocineAudience: undefined,
      rtStatus: undefined,
      rtTomatometer: undefined,
      rtCertifiedFresh: undefined,
    });
    const html = renderToStaticMarkup(
      React.createElement(MovieCard, { movie: sparse, cinemas: makeCinemas() }),
    );
    expect(html).toMatchSnapshot();
  });

  it('blocked-rating state renders the red ⚠ badge (not silent absence)', () => {
    const blocked = makeMovie({ rtStatus: 'blocked' });
    const html = renderToStaticMarkup(
      React.createElement(MovieCard, { movie: blocked, cinemas: makeCinemas() }),
    );
    expect(html).toMatchSnapshot();
  });
});

// ── WeekGrid ──────────────────────────────────────────────────────────────

describe('snapshot: WeekGrid', () => {
  const GRID_PROPS = {
    movies: [
      makeMovie({
        showtimes: [
          showtime('2099-07-12', 18.5),
          showtime('2099-07-13', 20.75, ['Localization.Version.Original']),
        ],
      }),
      makeMovie({
        id: '999',
        title: 'Avatar: Fire and Ash',
        showtimes: [showtime('2099-07-12', 21.25, ['Localization.Version.Original'])],
        hasVF: false,
        hasVO: true,
      }),
    ],
    cinemas: makeCinemas(),
    availableDays: ['2099-07-11', '2099-07-12', '2099-07-13'],
    hourMin: 18,
    hourMax: 22,
    hourFloor: 9,
    hourCeil: 25,
  };

  it('full grid (2 films × multiple showtimes, 18h–22h focus window)', () => {
    const html = renderToStaticMarkup(React.createElement(WeekGrid, GRID_PROPS));
    expect(html).toMatchSnapshot();
  });

  it('empty grid (no movies → header still renders the day columns)', () => {
    const html = renderToStaticMarkup(
      React.createElement(WeekGrid, { ...GRID_PROPS, movies: [] }),
    );
    expect(html).toMatchSnapshot();
  });
});

// ── LogViewer ─────────────────────────────────────────────────────────────

describe('snapshot: LogViewer', () => {
  it('initial shell (empty log store — effects do not run in a static render)', () => {
    const html = renderToStaticMarkup(React.createElement(LogViewer));
    expect(html).toMatchSnapshot();
  });
});
