import React, { useEffect, useState, useMemo, useCallback, useRef } from 'react';
import type { Movie, AudioFilter, CinemaInfo, CinemaStatus } from './types';
import { isVFShowtime, isVOShowtime } from './types';
import { normalize, todayIso } from '../shared/cinema';
import { fetchCinemas, fetchSchedule } from './api/cinemaApi';
// Version from package.json — injected at build time by Vite
const APP_VERSION = __APP_VERSION__;
import { CinemaSelector } from './components/CinemaSelector';
import { DaySelector } from './components/DaySelector';
import { FilterBar } from './components/FilterBar';
import { MovieCard } from './components/MovieCard';
import { WeekGrid } from './components/WeekGrid';
import { ViewToggle, type ViewMode } from './components/ViewToggle';
import type { SortMode } from './components/SortSelector';
import { CinemaStatusBanner } from './components/CinemaStatusBanner';
import appIcon from './assets/icon-64.png';
import { t, useLocale } from '../shared/i18n';

// ── Constants ───────────────────────────────────────────────────────────────

/** Shared style for header icon buttons (refresh, theme toggle). */
const headerBtnStyle: React.CSSProperties = {
  padding: '6px 10px',
  borderRadius: 8,
  border: '1px solid var(--border-light)',
  background: 'transparent',
  color: 'var(--text-muted)',
  cursor: 'pointer',
  fontSize: 14,
  lineHeight: 1,
};

/**
 * Initial hour slider range. UX-01: previously hardcoded 10h–24h, which
 * permanently hid matinées (e.g. 9h30 school screenings) and post-midnight
 * late shows. Now we keep a sensible default for the first paint but
 * dynamically expand the bounds once data arrives (see `hourBounds` state
 * below) so every showtime is reachable through the UI.
 */
const INITIAL_MIN_HOUR = 8;
const INITIAL_MAX_HOUR = 24;
/** Hard floor/ceiling on the hour slider — sanity bounds, never reached
 *  in practice but guards against pathological data. */
const HOUR_ABSOLUTE_FLOOR = 6;
const HOUR_ABSOLUTE_CEIL = 28;   // post-midnight shows displayed as 24h15, 25h30, etc.

// ── React.CSSProperties augmentation for `-webkit-app-region` ───────────────
//
// Electron's CSS extension `-webkit-app-region` makes a region draggable to
// move the window. It's not part of the standard React CSS type, so we cast
// style objects via this helper.
//
const dragStyle = {
  WebkitAppRegion: 'drag',
  WebkitUserSelect: 'none',
} as React.CSSProperties;
const noDragStyle = { WebkitAppRegion: 'no-drag' } as React.CSSProperties;

// ──────────────────────────────────────────────────────────────────────────

export const App: React.FC = () => {
  const [movies, setMovies] = useState<Movie[]>([]);
  const [availableDays, setAvailableDays] = useState<string[]>([]);
  const [cinemas, setCinemas] = useState<CinemaInfo[]>([]);
  const [cinemaStatuses, setCinemaStatuses] = useState<CinemaStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Filters
  const [selectedCinemaIds, setSelectedCinemaIds] = useState<string[]>([]); // [] = all
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const [audioFilter, setAudioFilter] = useState<AudioFilter>('ALL');
  const [minHour, setMinHour] = useState(INITIAL_MIN_HOUR);
  const [maxHour, setMaxHour] = useState(INITIAL_MAX_HOUR);
  const [search, setSearch] = useState('');

  /** UX-01: dynamic hour bounds derived from the actual showtime data.
   *  When movies arrive, expand the slider range to cover every showtime
   *  (clamped to [HOUR_ABSOLUTE_FLOOR, HOUR_ABSOLUTE_CEIL]). The slider
   *  then exposes matinées and late shows that were previously unreachable. */
  const [hourBounds, setHourBounds] = useState<{
    min: number; max: number;
  }>({ min: INITIAL_MIN_HOUR, max: INITIAL_MAX_HOUR });

  // View mode: 'day' (default) | 'week'
  const [viewMode, setViewMode] = useState<ViewMode>('day');

  /** Sort mode — default `next-screening` puts the most urgent movies first.
   *  When the user switches modes, the previous ordering is preserved as a
   *  stable secondary key (see `sortMovies` below). */
  const [sortMode, setSortMode] = useState<SortMode>('next-screening');

  /** UX-02: when the schedule was last successfully fetched. Displayed in
   *  the header so the user can tell stale data from fresh. */
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  /** Theme: 'dark' (default) or 'light'. Persisted in localStorage. */
  const [theme, setTheme] = useState<'dark' | 'light'>(() => {
    try { return (localStorage.getItem('arvecinema-theme') as 'dark' | 'light') ?? 'dark'; }
    catch { return 'dark'; }
  });

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    try { localStorage.setItem('arvecinema-theme', theme); } catch { /* ignore */ }
  }, [theme]);

  const toggleTheme = useCallback(() => {
    setTheme(prev => prev === 'dark' ? 'light' : 'dark');
  }, []);

  // i18n
  const { locale, setLocale } = useLocale();

  // ── Load cinema list (one-shot) ────────────────────────────────────────────
  useEffect(() => {
    fetchCinemas()
      .then(setCinemas)
      .catch(() => { /* non-fatal: the UI just hides the cinema selector */ });
  }, []);

  // ── Progressive ratings: listen for per-movie rating updates ──────────────
  // The main process returns movies immediately without ratings, then
  // enriches them in the background. Each enriched movie triggers a
  // `rating:updated` event that we handle here to patch the movie in state.
  useEffect(() => {
    const unsubscribe = window.electronAPI.onRatingUpdated((data) => {
      setMovies(prev => prev.map(m => {
        if (m.cinemaId !== data.cinemaId || m.id !== data.movieId) return m;
        return { ...m, ...data.ratings as Partial<typeof m> };
      }));
    });
    return unsubscribe;
  }, []);

  // ── Derive hour bounds from the actual showtime data (UX-01) ───────────────
  useEffect(() => {
    if (movies.length === 0) return;
    const hours = movies
      .flatMap(m => m.showtimes.map(s => s.hour))
      .filter(Number.isFinite);
    if (hours.length === 0) return;
    const lo = Math.max(HOUR_ABSOLUTE_FLOOR, Math.floor(Math.min(...hours)));
    const hi = Math.min(HOUR_ABSOLUTE_CEIL, Math.ceil(Math.max(...hours)));
    if (hi <= lo) return;   // pathological — keep previous bounds
    setHourBounds({ min: lo, max: hi });
    // If the user hasn't touched the slider yet (still at initial defaults),
    // expand the selection to cover all showtimes. Otherwise leave their
    // selection alone — they may have narrowed it intentionally.
    setMinHour(prev => prev < lo ? lo : prev);
    setMaxHour(prev => prev > hi ? hi : prev);
  }, [movies]);

  // ── Load schedule whenever the cinema selection changes ────────────────────
  //
  // We use a cancellation flag + useCallback so that React StrictMode's
  // double-mount in dev doesn't race two concurrent fetches.
  const reload = useCallback(() => {
    let cancelled = false;
    setLoading(true);
    const ids = selectedCinemaIds.length === 0 ? undefined : selectedCinemaIds;
    fetchSchedule(ids)
      .then(({ movies, availableDays, cinemaStatuses }) => {
        if (cancelled) return;
        setMovies(movies);
        setAvailableDays(availableDays);
        setCinemaStatuses(cinemaStatuses);
        setLastUpdated(new Date());
        // Pick a sensible default day if the current selection is no longer valid.
        const today = todayIso();
        setSelectedDay(prev =>
          prev && availableDays.includes(prev) ? prev
            : availableDays.includes(today) ? today
            : (availableDays[0] ?? null),
        );
        setError(null);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [selectedCinemaIds]);

  useEffect(() => reload(), [reload]);

  // Auto-refresh DISABLED: re-fetching the cinema schedule while the app is
  // open causes the movie cards to shift/reorder as ratings stream in,
  // which is jarring during use. The user can manually refresh with the ↻
  // button when they want fresh data.

  /** Manual refresh — called by the ↻ button. */
  const refresh = useCallback(() => {
    reload();
  }, [reload]);

  // ── Filter pipeline ──────────────────────────────────────────────────────
  //
  // Stage 1: search filter (movie-level).
  //          Matches against title + director + cast, accent-insensitive.
  //
  const searchFiltered = useMemo(() => {
    const q = normalize(search.trim());
    if (!q) return movies;
    return movies.filter(m =>
      normalize(`${m.title} ${m.direction} ${m.casting}`).includes(q),
    );
  }, [movies, search]);

  // Stage 2: audio filter (showtime-level — keep only matching showtimes).
  const audioFiltered = useMemo(() => {
    if (audioFilter === 'ALL') return searchFiltered;
    return searchFiltered
      .map(m => ({
        ...m,
        showtimes: m.showtimes.filter(s =>
          audioFilter === 'VF' ? isVFShowtime(s.tags) : isVOShowtime(s.tags),
        ),
      }))
      .filter(m => m.showtimes.length > 0);
  }, [searchFiltered, audioFilter]);

  // Stage 3a (day view): filter by day + hour, then DEDUPLICATE by title.
  // The same film at multiple cinemas shows as ONE card with all showtimes
  // combined (color-coded by cinema).
  const dayViewMovies = useMemo(() => {
    const filtered = audioFiltered
      .map(m => ({
        ...m,
        showtimes: m.showtimes.filter(s =>
          (selectedDay === null || s.day === selectedDay) &&
          s.hour >= minHour && s.hour <= maxHour,
        ),
      }))
      .filter(m => m.showtimes.length > 0);

    // Group by (normalized title, year) — merge into a single Movie
    // with all showtimes from all cinema copies.
    // Year fallback: if movie.release is undefined (HTML scrapers don't set it),
    // extract the year from the first showtime's day (YYYY-MM-DD).
    const groups = new Map<string, typeof filtered>();
    for (const m of filtered) {
      const year = m.release?.slice(0, 4)
        ?? (m.showtimes[0]?.day?.slice(0, 4) ?? '');
      const key = `${normalize(m.title)}:${year}`;
      const arr = groups.get(key) ?? [];
      arr.push(m);
      groups.set(key, arr);
    }

    return [...groups.values()].map(group => {
      if (group.length === 1) return group[0];
      // Merge: take fields from the first copy, but combine showtimes and
      // pick ratings from whichever copy has them.
      const merged = { ...group[0] };
      merged.showtimes = group.flatMap(m => m.showtimes).sort((a, b) => a.time.localeCompare(b.time));
      merged.hasVF = group.some(m => m.hasVF);
      merged.hasVO = group.some(m => m.hasVO);
      // Pick ratings from whichever copy has them
      for (const m of group) {
        if (m.imdbId && !merged.imdbId) merged.imdbId = m.imdbId;
        if (m.imdbRating !== undefined && merged.imdbRating === undefined) merged.imdbRating = m.imdbRating;
        if (m.imdbVotes !== undefined && merged.imdbVotes === undefined) merged.imdbVotes = m.imdbVotes;
        if (m.imdbUrl && !merged.imdbUrl) merged.imdbUrl = m.imdbUrl;
        if (m.imdbStatus && !merged.imdbStatus) { merged.imdbStatus = m.imdbStatus; merged.imdbStatusMessage = m.imdbStatusMessage; }
        if (m.allocinePress !== undefined && merged.allocinePress === undefined) merged.allocinePress = m.allocinePress;
        if (m.allocineAudience !== undefined && merged.allocineAudience === undefined) merged.allocineAudience = m.allocineAudience;
        if (m.allocineVotes !== undefined && merged.allocineVotes === undefined) merged.allocineVotes = m.allocineVotes;
        if (m.allocineUrl && !merged.allocineUrl) merged.allocineUrl = m.allocineUrl;
        if (m.allocineStatus && !merged.allocineStatus) { merged.allocineStatus = m.allocineStatus; merged.allocineStatusMessage = m.allocineStatusMessage; }
        if (m.rtTomatometer !== undefined && merged.rtTomatometer === undefined) merged.rtTomatometer = m.rtTomatometer;
        if (m.rtCertifiedFresh !== undefined && merged.rtCertifiedFresh === undefined) merged.rtCertifiedFresh = m.rtCertifiedFresh;
        if (m.rtUrl && !merged.rtUrl) merged.rtUrl = m.rtUrl;
        if (m.rtStatus && !merged.rtStatus) { merged.rtStatus = m.rtStatus; merged.rtStatusMessage = m.rtStatusMessage; }
        if (m.wikidataUrl && !merged.wikidataUrl) merged.wikidataUrl = m.wikidataUrl;
      }
      return merged;
    });
  }, [audioFiltered, selectedDay, minHour, maxHour]);

  // Stage 3b (week view): no further filtering — WeekGrid handles the hour
  // window + "any day" rule internally.
  const weekViewMovies = audioFiltered;

  // ── Sort ──────────────────────────────────────────────────────────────────
  //
  // Stable multi-key sort that preserves the previous order as a secondary
  // key when the user switches sort mode. Implementation: keep a ref to
  // the previously-sorted array's order, and when re-sorting, use the
  // previous position as a tiebreaker for equal-ranked items.
  //
  // Why a ref rather than state? We don't want this to trigger re-renders —
  // it's only read inside the useMemo below.
  const previousOrderRef = useRef<Map<string, number>>(new Map());

  /** Compute the sort key for a movie under the current mode.
   *  Returns a tuple: lower = earlier in the list. */
  const sortKeyFor = (m: Movie): [number, string] => {
    if (sortMode === 'next-screening') {
      // Earliest showtime (after now) that passes the day + hour + audio filters.
      const now = Date.now();
      const upcoming = m.showtimes
        .filter(s => {
          const t = new Date(s.time).getTime();
          if (Number.isNaN(t) || t < now) return false;
          if (selectedDay !== null && s.day !== selectedDay) return false;
          if (s.hour < minHour || s.hour > maxHour) return false;
          if (audioFilter === 'VF' && !isVFShowtime(s.tags)) return false;
          if (audioFilter === 'VO' && !isVOShowtime(s.tags)) return false;
          return true;
        })
        .map(s => new Date(s.time).getTime());
      const earliest = upcoming.length === 0
        ? Number.POSITIVE_INFINITY   // no upcoming → sinks to bottom
        : Math.min(...upcoming);
      return [earliest, normalize(m.title)];
    }
    if (sortMode === 'cinema') {
      // Group by cinema index (registry order); secondary key = title.
      const cinemaIdx = cinemas.findIndex(c => c.id === m.cinemaId);
      return [cinemaIdx < 0 ? Number.MAX_SAFE_INTEGER : cinemaIdx, normalize(m.title)];
    }
    // 'title'
    return [0, normalize(m.title)];
  };

  /** Sort movies with stable tie-breaking on the previous ordering. */
  const sortedDayMovies = useMemo(() => {
    const prev = previousOrderRef.current;
    const indexed = dayViewMovies.map((m, i) => ({ m, prevIdx: prev.get(`${m.cinemaId}-${m.id}`) ?? i }));

    indexed.sort((a, b) => {
      const [ka1, ka2] = sortKeyFor(a.m);
      const [kb1, kb2] = sortKeyFor(b.m);
      if (ka1 !== kb1) return ka1 < kb1 ? -1 : 1;
      if (ka2 !== kb2) return ka2 < kb2 ? -1 : ka2 > kb2 ? 1 : 0;
      // Tie: fall back to previous ordering.
      const pa = a.prevIdx, pb = b.prevIdx;
      return pa < pb ? -1 : pa > pb ? 1 : 0;
    });

    // Update the ref so the NEXT sort uses this order as the tiebreaker.
    const next = new Map<string, number>();
    indexed.forEach((item, i) => next.set(`${item.m.cinemaId}-${item.m.id}`, i));
    previousOrderRef.current = next;

    return indexed.map(item => item.m);
  // We deliberately exclude `previousOrderRef` from deps — it's a ref, not state.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dayViewMovies, sortMode, cinemas, selectedDay, minHour, maxHour, audioFilter]);

  /** Week view uses the same sort for consistency. */
  const sortedWeekMovies = useMemo(() => {
    const prev = previousOrderRef.current;
    const indexed = weekViewMovies.map((m, i) => ({ m, prevIdx: prev.get(`${m.cinemaId}-${m.id}`) ?? i }));

    indexed.sort((a, b) => {
      const [ka1, ka2] = sortKeyFor(a.m);
      const [kb1, kb2] = sortKeyFor(b.m);
      if (ka1 !== kb1) return ka1 < kb1 ? -1 : 1;
      if (ka2 !== kb2) return ka2 < kb2 ? -1 : ka2 > kb2 ? 1 : 0;
      const pa = a.prevIdx, pb = b.prevIdx;
      return pa < pb ? -1 : pa > pb ? 1 : 0;
    });

    const next = new Map<string, number>();
    indexed.forEach((item, i) => next.set(`${item.m.cinemaId}-${item.m.id}`, i));
    previousOrderRef.current = next;

    return indexed.map(item => item.m);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [weekViewMovies, sortMode, cinemas, selectedDay, minHour, maxHour, audioFilter]);

  // ── Early returns for loading / error states ─────────────────────────────
  if (loading && movies.length === 0) {
    return <div style={{ color: 'var(--text-primary)', padding: 40, textAlign: 'center' }}>{t('loading')}</div>;
  }
  if (error) {
    return <div style={{ color: '#e50914', padding: 40, textAlign: 'center' }}>{t('error')}: {error}</div>;
  }

  const selectedCinemaCount = selectedCinemaIds.length === 0
    ? cinemas.length
    : selectedCinemaIds.length;
  const visibleCount = viewMode === 'day' ? sortedDayMovies.length : sortedWeekMovies.length;

  return (
    <div style={{
      background: 'var(--bg-primary)',
      color: 'var(--text-primary)',
      display: 'flex',
      flexDirection: 'column',
      height: '100vh',     // UX-04: flex column, no more calc(100vh - 250px) guess
      overflow: 'hidden',
    }}>
      <header style={{
        padding: '18px 24px 12px',
        borderBottom: '1px solid var(--border)',
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        flex: '0 0 auto',
        ...dragStyle,    // makes the header draggable to move the window
      }}>
        <img
          src={appIcon}
          alt=""
          width={36}
          height={36}
          style={{
            display: 'block', borderRadius: 8, flex: '0 0 auto',
            pointerEvents: 'none',     // clicks pass through to the draggable header
          }}
        />
        <div style={{ flex: 1, minWidth: 0 }}>
          <h1 style={{ margin: 0, fontSize: 24, fontWeight: 800 }}>
            {t('appTitle')} <span style={{ fontSize: 12, fontWeight: 400, color: 'var(--text-faint)' }}>v{APP_VERSION}</span>
          </h1>
          <p style={{ margin: '4px 0 0', color: 'var(--text-muted)', fontSize: 14 }}>
            {visibleCount} {visibleCount > 1 ? t('films') : t('film')} —{' '}
            {viewMode === 'day' && selectedDay !== null
              ? new Date(`${selectedDay}T12:00:00Z`).toLocaleDateString(locale === 'fr' ? 'fr-FR' : 'en-US', {
                  weekday: 'long', day: '2-digit', month: 'long', timeZone: 'UTC',
                })
              : t('week')}
            {' '}· {selectedCinemaCount} {selectedCinemaCount > 1 ? t('cinemas') : t('cinema_singular')}
          </p>
        </div>
        {/* ViewToggle + Refresh + last-updated must remain clickable even
            though the header is draggable. */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, ...noDragStyle }}>
          {lastUpdated && (
            <span style={{
              color: 'var(--text-dim)',
              fontSize: 11,
              fontVariantNumeric: 'tabular-nums',
              whiteSpace: 'nowrap',
            }}>
              {t('updated')} {lastUpdated.toLocaleTimeString(locale === 'fr' ? 'fr-FR' : 'en-US', {
                hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris',
              })}
            </span>
          )}
          <button
            type="button"
            onClick={refresh}
            aria-label={t('refresh')}
            title={t('refreshTooltip')}
            style={headerBtnStyle}
          >
            ↻
          </button>
          <button
            type="button"
            onClick={toggleTheme}
            aria-label={t('themeToggle_dark')}
            title={theme === 'dark' ? t('themeToggle_dark') : t('themeToggle_light')}
            style={headerBtnStyle}
          >
            {theme === 'dark' ? '☀' : '🌙'}
          </button>
          <button
            type="button"
            onClick={() => setLocale(locale === 'fr' ? 'en' : 'fr')}
            aria-label={t('language')}
            title={locale === 'fr' ? t('english') : t('french')}
            style={headerBtnStyle}
          >
            {locale === 'fr' ? '🇬🇧' : '🇫🇷'}
          </button>
          <ViewToggle value={viewMode} onChange={setViewMode} />
        </div>
      </header>

      <CinemaSelector
        cinemas={cinemas}
        selectedIds={selectedCinemaIds}
        onChange={setSelectedCinemaIds}
      />

      {/* Day selector only in day view */}
      {viewMode === 'day' && (
        <DaySelector
          availableDays={availableDays}
          selectedDay={selectedDay}
          onSelect={setSelectedDay}
        />
      )}

      <FilterBar
        audioFilter={audioFilter} setAudioFilter={setAudioFilter}
        minHour={minHour} setMinHour={setMinHour}
        maxHour={maxHour} setMaxHour={setMaxHour}
        hourBounds={hourBounds}
        search={search} setSearch={setSearch}
        sortMode={sortMode} setSortMode={setSortMode}
      />

      {/* CMB-005: surface per-cinema failures so the user can tell
          "no screenings" from "server unreachable". */}
      <CinemaStatusBanner cinemas={cinemas} statuses={cinemaStatuses} />

      {viewMode === 'day' ? (
        <main style={{
          padding: '20px 24px',
          display: 'flex', flexDirection: 'column', gap: 12,
          maxWidth: 1100, margin: '0 auto', width: '100%',
          // UX-04: take remaining vertical space + own scroll context.
          flex: '1 1 auto',
          minHeight: 0,
          overflowY: 'auto',
        }}>
          {dayViewMovies.length === 0 ? (
            <div style={{ color: 'var(--text-muted)', padding: 40, textAlign: 'center' }}>
              {t('noResults')}
            </div>
          ) : (
            sortedDayMovies.map(movie => (
              <MovieCard key={`${movie.cinemaId}-${movie.id}`} movie={movie} cinemas={cinemas} />
            ))
          )}
        </main>
      ) : (
        <main style={{
          padding: '0 0 24px 0',
          // UX-04: take remaining vertical space + let WeekGrid manage its own scroll.
          flex: '1 1 auto',
          minHeight: 0,
          overflow: 'hidden',
        }}>
          <WeekGrid
            movies={sortedWeekMovies}
            cinemas={cinemas}
            availableDays={availableDays}
            hourMin={minHour}
            hourMax={maxHour}
            hourFloor={hourBounds.min}
            hourCeil={hourBounds.max}
          />
        </main>
      )}
    </div>
  );
};
