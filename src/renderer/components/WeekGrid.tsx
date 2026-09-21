import React, { useMemo, useRef, useCallback } from 'react';
import type { Movie, CinemaInfo, Showtime } from '../types';
import { showtimeVersion, DEFAULT_RUNTIME_HOURS } from '../types';
import { formatTime, formatDayShort, cinemaColor, cinemaName } from '../../shared/cinema';
import { t, formatDecimal } from '../../shared/i18n';

// ──────────────────────────────────────────────────────────────────────────
// WeekGrid — weekly swimlane view
// ──────────────────────────────────────────────────────────────────────────
// Layout:
//
//   ┌─────────────────────┬─────────────────────────────────────────────────┐
//   │ STICKY LEFT         │  SWIMLANE (both axes scrollable)               │
//   │ ┌───┐ Ciné MB       │  ┌───────┬───────┬═══════┬───────┬───────┐       │
//   │ │POS│ Spider-Man    │  │10h 11h│10h 11h│10h 11h│10h 11h│10h 11h│ ...  │
//   │ │TER│ Réal. X       │  ├───────┼───────┼═══════┼───────┼───────┤      │
//   │ │   │ Avec Y, Z     │  │       │ 19h45 │       │       │       │      │
//   │ └───┘               │  │       │ VO    │       │       │       │      │
//   └─────────────────────┴─────────────────────────────────────────────────┘
//        ↑ sticky + poster        ↑ sticky top (header row stays visible)
//
// Interactions:
//   - Horizontal scroll: scrollbar, trackpad, OR middle-click drag (hand tool)
//   - Vertical scroll:   scrollbar, trackpad, OR middle-click drag (hand tool)
//   - Header row sticks to top of container while scrolling vertically
//   - Sticky left col sticks to left of container while scrolling horizontally
//
// Two distinct hour windows:
//   - `displayMin/Max` — what hour columns the swimlane renders. Expanded
//     by ±2h around the slider so the user sees context around the focus range.
//   - `matchMin/Max`   — what hour a showtime must fall in to be considered a
//     match (for movie inclusion AND chip rendering). Strict slider range.
//
// Example: slider 18h00 – 20h45
//   → columns displayed: 16h, 17h, 18h, 19h, 20h (and 21h only if winMax is 21)
//   → a movie with only a 21h45 screening is NOT shown
//   → a chip at 21h45 is NOT rendered (even though the 21h column may exist)
// ──────────────────────────────────────────────────────────────────────────

interface Props {
  movies: Movie[];
  cinemas: CinemaInfo[];
  availableDays: string[];
  hourMin: number;
  hourMax: number;
  /** UX-01: dynamic hour bounds (derived from data) replacing the old
   *  hardcoded 10h–24h floor/ceiling. */
  hourFloor: number;
  hourCeil: number;
}

// ── Layout constants ────────────────────────────────────────────────────────

const HOUR_COL_WIDTH = 56; // px per integer hour
const STICKY_COL_WIDTH = 300; // px — room for poster + 4 lines of text
const ROW_HEIGHT = 96; // px — poster is 66px + 4 text lines + padding
const POSTER_W = 44;
const POSTER_H = 66;
const SCROLLBAR_RESERVE = 16; // px — reserve room so scrollbar doesn't overlap last row

/** Background colors for the two hour zones of each day strip.
 *  Uses CSS variables so they adapt to the theme. */
const COLOR_CONTEXT = 'var(--bg-strip-dim)'; // dim — hours outside slider range
const COLOR_IN_RANGE = 'var(--bg-strip-active)'; // brighter — hours inside slider range

/** Hour padding around the slider for the display window. */
const DISPLAY_PADDING_HOURS = 2;

export const WeekGrid: React.FC<Props> = ({
  movies,
  cinemas,
  availableDays,
  hourMin,
  hourMax,
  hourFloor,
  hourCeil,
}) => {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const dragState = useRef<{
    startX: number;
    startY: number;
    scrollLeft: number;
    scrollTop: number;
  } | null>(null);

  // ── Hour windows ──────────────────────────────────────────────────────────
  //
  // Two distinct hour windows:
  //   - `displayMin/Max` — what hour columns the swimlane renders. Expanded
  //     by ±2h around the slider so the user sees context around the focus range.
  //   - `matchMin/Max`   — what hour a showtime must fall in to be considered
  //     a match (for movie inclusion AND chip rendering). Strict slider range.
  //
  // Example: slider 18h00 – 20h45
  //   → columns displayed: 16h, 17h, 18h, 19h, 20h (and 21h only if winMax is 21)
  //   → a movie with only a 21h45 screening is NOT shown
  //   → a chip at 21h45 is NOT rendered (even though the 21h column may exist)
  const matchMin = Math.max(hourFloor, hourMin);
  const matchMax = Math.min(hourCeil, hourMax);
  const displayMin = Math.max(hourFloor, hourMin - DISPLAY_PADDING_HOURS);
  const displayMax = Math.min(hourCeil, hourMax + DISPLAY_PADDING_HOURS);

  // All hour columns from floor(displayMin) to floor(displayMax) INCLUSIVE.
  // The header renders one cell per integer hour. The day strip has the
  // SAME width as the header so they align perfectly: both use
  // hours.length × HOUR_COL_WIDTH.
  const hours: number[] = [];
  for (let h = Math.floor(displayMin); h <= Math.floor(displayMax); h++) hours.push(h);

  // The day strip width MUST equal the header width: hours.length × HOUR_COL_WIDTH.
  // NOT displaySpan × HOUR_COL_WIDTH (which would be off by one because
  // hours.length counts boundaries, displaySpan counts intervals).
  const dayStripWidth = hours.length * HOUR_COL_WIDTH;

  /** Convert an hour float to a pixel offset within a day strip. */
  const hourToX = (h: number) => (h - Math.floor(displayMin)) * HOUR_COL_WIDTH;

  // Background gradient: 3-stop — context | in-range | context.
  // Use the SAME coordinate system as hourToX: floor(displayMin) based.
  const stripDisplayMin = Math.floor(displayMin);
  const stripSpan = hours.length; // same as dayStripWidth / HOUR_COL_WIDTH
  const inRangeLeftPct = ((matchMin - stripDisplayMin) / stripSpan) * 100;
  const inRangeRightPct = ((matchMax - stripDisplayMin) / stripSpan) * 100;
  const stripBackground = `linear-gradient(to right,
    ${COLOR_CONTEXT} 0%, ${COLOR_CONTEXT} ${inRangeLeftPct}%,
    ${COLOR_IN_RANGE} ${inRangeLeftPct}%, ${COLOR_IN_RANGE} ${inRangeRightPct}%,
    ${COLOR_CONTEXT} ${inRangeRightPct}%, ${COLOR_CONTEXT} 100%
  )`;

  // ── Filter + lookup ──────────────────────────────────────────────────────
  const visibleMovies = useMemo(
    () => movies.filter((m) => m.showtimes.some((s) => s.hour >= matchMin && s.hour <= matchMax)),
    [movies, matchMin, matchMax],
  );

  const visibleDays = useMemo(
    () =>
      availableDays.filter((d) =>
        visibleMovies.some((m) =>
          m.showtimes.some((s) => s.day === d && s.hour >= matchMin && s.hour <= matchMax),
        ),
      ),
    [availableDays, visibleMovies, matchMin, matchMax],
  );

  // Per (movie, day) showtime list — NOT bucketed by hour, so chips can be
  // positioned continuously by real start time.
  //
  // Key: `${m.id}|${s.day}` — keyed by MOVIE ID + day, NOT by cinema.
  // After dedup, a merged movie may have showtimes from multiple cinemas
  // (each with its own showtime.cinemaId). Using the movie-level id as
  // the key ensures all showtimes for the same film on the same day are
  // grouped together regardless of which cinema they came from.
  const showtimesByDay = useMemo(() => {
    const map = new Map<string, Showtime[]>();
    for (const m of visibleMovies) {
      for (const s of m.showtimes) {
        if (s.hour < matchMin || s.hour > matchMax) continue;
        const key = `${m.id}|${s.day}`;
        const arr = map.get(key) ?? [];
        arr.push(s);
        map.set(key, arr);
      }
    }
    for (const arr of map.values()) arr.sort((a, b) => a.time.localeCompare(b.time));
    return map;
  }, [visibleMovies, matchMin, matchMax]);

  // ── Middle-click drag (hand-tool panning) ─────────────────────────────────
  const onMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 1) return; // 1 = middle mouse button
    e.preventDefault(); // suppress default middle-click autoscroll
    const el = scrollRef.current;
    if (!el) return;
    dragState.current = {
      startX: e.clientX,
      startY: e.clientY,
      scrollLeft: el.scrollLeft,
      scrollTop: el.scrollTop,
    };
    document.body.style.cursor = 'grabbing';
    document.body.style.userSelect = 'none';
  }, []);

  const onMouseMove = useCallback((e: React.MouseEvent) => {
    const drag = dragState.current;
    const el = scrollRef.current;
    if (!drag || !el) return;
    el.scrollLeft = drag.scrollLeft - (e.clientX - drag.startX);
    el.scrollTop = drag.scrollTop - (e.clientY - drag.startY);
  }, []);

  const endDrag = useCallback(() => {
    if (!dragState.current) return;
    dragState.current = null;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  }, []);

  // ── Empty state ───────────────────────────────────────────────────────────
  if (visibleMovies.length === 0) {
    return (
      <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)' }}>
        {t('noResults')}
      </div>
    );
  }

  const gridWidth = visibleDays.length * dayStripWidth;

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div
      ref={scrollRef}
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseUp={endDrag}
      onMouseLeave={endDrag}
      onWheel={(e) => {
        // Shift + wheel = horizontal scroll — useful on trackpads that
        // don't expose horizontal scroll natively.
        if (e.shiftKey && scrollRef.current) {
          scrollRef.current.scrollLeft += e.deltaY;
          e.preventDefault();
        }
      }}
      style={{
        // Both axes scrollable. `overflow: scroll` (not `auto`) forces the
        // scrollbar to render even on macOS where it auto-hides by default.
        overflow: 'scroll',
        // UX-04: was `maxHeight: 'calc(100vh - 250px)'` — a magic guess that
        // broke whenever the header / banner / wrapped FilterBar changed
        // height. Now the parent <main> is a flex child with `flex: 1 1 auto`
        // and `minHeight: 0`, so we just fill it.
        height: '100%',
        position: 'relative',
        cursor: 'grab',
        background: 'var(--bg-primary)',
        userSelect: 'none',
      }}
    >
      <div
        style={{
          minWidth: STICKY_COL_WIDTH + gridWidth + SCROLLBAR_RESERVE,
          position: 'relative',
        }}
      >
        {/* ── Header row: STICKY TOP ───────────────────────────────────── */}
        <div style={{ display: 'flex', position: 'sticky', top: 0, zIndex: 5 }}>
          {/* Corner cell (sticky left) */}
          <div
            style={{
              flex: `0 0 ${STICKY_COL_WIDTH}px`,
              position: 'sticky',
              left: 0,
              zIndex: 6,
              background: 'var(--bg-primary)',
              padding: '10px 14px',
              borderBottom: '1px solid var(--border-light)',
              fontSize: 11,
              color: 'var(--text-muted)',
              fontWeight: 600,
              letterSpacing: 0.3,
              textTransform: 'uppercase',
            }}
          >
            {visibleMovies.length} film{visibleMovies.length > 1 ? 's' : ''}
          </div>

          {/* Day × hour header cells */}
          <div style={{ display: 'flex' }}>
            {visibleDays.map((day) => {
              const { weekday, dayNum } = formatDayShort(day);
              return (
                <div key={day} style={{ display: 'flex' }}>
                  {hours.map((h, hi) => {
                    const inRange = h >= matchMin && h <= matchMax;
                    return (
                      <div
                        key={h}
                        style={{
                          width: HOUR_COL_WIDTH,
                          flex: `0 0 ${HOUR_COL_WIDTH}px`,
                          position: 'relative',
                          background: inRange ? 'var(--bg-strip-active)' : 'var(--bg-strip-dim)',
                          borderBottom: '1px solid var(--border-light)',
                        }}
                      >
                        {/* Day label in the first column */}
                        {hi === 0 && (
                          <div
                            style={{
                              fontSize: 11,
                              color: 'var(--text-primary)',
                              textTransform: 'capitalize' as const,
                              fontWeight: 700,
                              padding: '6px 0 2px',
                              textAlign: 'center',
                            }}
                          >
                            {weekday} {dayNum}
                          </div>
                        )}
                        {/* Hour label — positioned at the LEFT edge of the cell
                            (over the tick line), shifted left by half its width
                            so it sits centered above the boundary, not in the
                            middle of the cell. */}
                        <div
                          style={{
                            position: 'absolute',
                            bottom: '10px',
                            left: 0,
                            transform: 'translateX(-50%)',
                            fontSize: 11,
                            fontWeight: inRange ? 600 : 400,
                            color: inRange ? 'var(--text-secondary)' : 'var(--text-faint)',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {h}h
                        </div>
                        {/* Vertical tick line — full height of the cell, at the left edge */}
                        <div
                          style={{
                            position: 'absolute',
                            top: 0,
                            bottom: 0,
                            left: 0,
                            width: hi === 0 ? 3 : 1,
                            background: hi === 0 ? 'var(--text-muted)' : 'var(--border-light)',
                          }}
                        />
                        {/* Last hour also needs a right-edge tick + label */}
                        {hi === hours.length - 1 && (
                          <>
                            <div
                              style={{
                                position: 'absolute',
                                top: 0,
                                bottom: 0,
                                right: 0,
                                width: 1,
                                background: 'var(--border-light)',
                              }}
                            />
                            <div
                              style={{
                                position: 'absolute',
                                bottom: '10px',
                                right: 0,
                                transform: 'translateX(50%)',
                                fontSize: 11,
                                fontWeight: inRange ? 600 : 400,
                                color: inRange ? 'var(--text-secondary)' : 'var(--text-faint)',
                                whiteSpace: 'nowrap',
                              }}
                            >
                              {h + 1}h
                            </div>
                          </>
                        )}
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
        </div>

        {/* ── Movie rows ───────────────────────────────────────────────── */}
        {visibleMovies.map((m) => (
          <WeekRow
            key={`${m.cinemaId}-${m.id}`}
            movie={m}
            cinemas={cinemas}
            visibleDays={visibleDays}
            hours={hours}
            hourToX={hourToX}
            dayStripWidth={dayStripWidth}
            stripBackground={stripBackground}
            showtimesByDay={showtimesByDay}
          />
        ))}

        {/* Spacer so the scrollbar doesn't overlap the last row */}
        <div style={{ height: SCROLLBAR_RESERVE }} />
      </div>
    </div>
  );
};

// ──────────────────────────────────────────────────────────────────────────
// WeekRow — one movie's full row (sticky left cell + N day strips)
// ──────────────────────────────────────────────────────────────────────────

interface WeekRowProps {
  movie: Movie;
  cinemas: CinemaInfo[];
  visibleDays: string[];
  hours: number[];
  hourToX: (h: number) => number;
  dayStripWidth: number;
  stripBackground: string;
  showtimesByDay: Map<string, Showtime[]>;
}

const WeekRow: React.FC<WeekRowProps> = ({
  movie,
  cinemas,
  visibleDays,
  hours,
  hourToX,
  dayStripWidth,
  stripBackground,
  showtimesByDay,
}) => {
  const color = cinemaColor(cinemas, movie.cinemaId);
  const name = cinemaName(cinemas, movie.cinemaId);
  const actors = movie.casting
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 2);
  const hasDirection = movie.direction && movie.direction !== t('unspecified');
  const runtimeHours = movie.runtime ? movie.runtime / 60 : DEFAULT_RUNTIME_HOURS;

  return (
    <div style={{ display: 'flex', height: ROW_HEIGHT }}>
      {/* ── Sticky left: poster + cinema + title + director + actors ──── */}
      <div
        style={{
          flex: `0 0 ${STICKY_COL_WIDTH}px`,
          position: 'sticky',
          left: 0,
          zIndex: 2,
          background: 'var(--bg-card)',
          padding: '8px 12px 8px 14px',
          borderBottom: '1px solid var(--border-light)',
          borderLeft: `3px solid ${color}`,
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          overflow: 'hidden',
        }}
      >
        {/* Poster thumbnail */}
        <div
          style={{
            flex: '0 0 auto',
            width: POSTER_W,
            height: POSTER_H,
            borderRadius: 4,
            overflow: 'hidden',
            background: 'var(--bg-card-2)',
            position: 'relative',
            flexShrink: 0,
          }}
        >
          {movie.poster ? (
            <img
              src={movie.poster}
              alt=""
              style={{
                width: '100%',
                height: '100%',
                objectFit: 'cover',
                display: 'block',
              }}
              loading="lazy"
              referrerPolicy="no-referrer"
            />
          ) : (
            <div
              style={{
                position: 'absolute',
                inset: 0,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: 'var(--text-faint)',
                fontSize: 9,
                textAlign: 'center',
                padding: 4,
              }}
            >
              {t('noPoster')}
            </div>
          )}
        </div>

        {/* Text column */}
        <div
          style={{
            flex: 1,
            minWidth: 0,
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'center',
            gap: 2,
          }}
        >
          <div
            style={{
              fontSize: 10,
              color,
              fontWeight: 700,
              textTransform: 'uppercase' as const,
              letterSpacing: 0.4,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {name}
          </div>
          <div
            style={{
              color: 'var(--text-primary)',
              fontWeight: 700,
              fontSize: 14,
              lineHeight: 1.2,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {movie.title}
          </div>
          <div
            style={{
              color: 'var(--text-muted)',
              fontSize: 11,
              fontWeight: 400,
              lineHeight: 1.3,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {hasDirection && (
              <span>
                <span style={{ color: 'var(--text-dim)' }}>Réal. </span>
                {movie.direction}
              </span>
            )}
            {actors.length > 0 && (
              <span>
                {hasDirection ? '  ·  ' : ''}
                <span style={{ color: 'var(--text-dim)' }}>Avec </span>
                {actors.join(', ')}
              </span>
            )}
          </div>
          {/* Compact rating badges on their own line so they don't get truncated */}
          {(movie.imdbRating !== undefined ||
            movie.allocinePress !== undefined ||
            movie.allocineAudience !== undefined ||
            movie.rtTomatometer !== undefined ||
            (movie.wikidataUrl === undefined &&
              movie.imdbStatus === undefined &&
              movie.allocineStatus === undefined &&
              movie.rtStatus === undefined)) && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 1 }}>
              {movie.imdbRating !== undefined && (
                <span style={{ color: '#f5c518', fontSize: 10, fontWeight: 700 }}>
                  ⭐{movie.imdbRating.toFixed(1)}
                </span>
              )}
              {(movie.allocinePress !== undefined || movie.allocineAudience !== undefined) && (
                <span style={{ fontSize: 10, fontWeight: 600 }}>
                  {movie.allocinePress !== undefined && (
                    <span style={{ color: acColorCompact(movie.allocinePress) }}>
                      ✍{formatDecimal(movie.allocinePress)}
                    </span>
                  )}
                  {movie.allocineAudience !== undefined && (
                    <span style={{ color: acColorCompact(movie.allocineAudience) }}>
                      {' '}
                      👥{formatDecimal(movie.allocineAudience)}
                    </span>
                  )}
                </span>
              )}
              {movie.rtTomatometer !== undefined && (
                <span
                  style={{
                    color: scoreColorCompact(movie.rtTomatometer),
                    fontSize: 10,
                    fontWeight: 700,
                  }}
                >
                  {movie.rtTomatometer >= 60 ? '🍅' : '🤢'}
                  {movie.rtTomatometer}%
                </span>
              )}
              {movie.wikidataUrl === undefined &&
                movie.imdbStatus === undefined &&
                movie.allocineStatus === undefined &&
                movie.rtStatus === undefined && (
                  <span style={{ color: 'var(--text-faint)', fontSize: 10 }}>❓</span>
                )}
            </div>
          )}
        </div>
      </div>

      {/* ── Day × continuous-time strips ───────────────────────────────── */}
      <div style={{ display: 'flex' }}>
        {visibleDays.map((day, dayIdx) => {
          const key = `${movie.id}|${day}`;
          const sts = showtimesByDay.get(key) ?? [];
          return (
            <div
              key={day}
              style={{
                width: dayStripWidth,
                flex: `0 0 ${dayStripWidth}px`,
                position: 'relative',
                height: ROW_HEIGHT,
                borderBottom: '1px solid var(--border-light)',
                borderLeft:
                  dayIdx === 0 ? '3px solid var(--border-light)' : '1px solid var(--border-light)',
                background: stripBackground,
                overflow: 'visible', // let chips extend beyond the strip
              }}
            >
              {/* Hour gridlines (faint vertical lines at each integer hour) */}
              {hours.map((h) => {
                const x = hourToX(h);
                if (x <= 0 || x >= dayStripWidth) return null;
                return (
                  <div
                    key={h}
                    style={{
                      position: 'absolute',
                      top: 0,
                      bottom: 0,
                      left: x,
                      width: 1,
                      background: 'var(--bg-card-2)',
                      pointerEvents: 'none',
                    }}
                  />
                );
              })}

              {/* Showtime chips — positioned by real start time, width = runtime */}
              {sts.map((s, i) => (
                <ShowtimeChip
                  key={i}
                  showtime={s}
                  cinemaName={cinemas.find((c) => c.id === s.cinemaId)?.name ?? s.cinemaId}
                  color={color}
                  runtimeHours={runtimeHours}
                  runtimeMinutes={movie.runtime}
                  hourToX={hourToX}
                />
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
};

// ──────────────────────────────────────────────────────────────────────────
// ShowtimeChip — one absolutely-positioned chip in a day strip
// ──────────────────────────────────────────────────────────────────────────

interface ShowtimeChipProps {
  showtime: Showtime;
  cinemaName: string;
  color: string;
  runtimeHours: number;
  runtimeMinutes?: number;
  hourToX: (h: number) => number;
}

/** Hide the VF/VO badge on very narrow chips so the time stays readable. */
const MIN_CHIP_WIDTH_FOR_BADGE = 70;
/** Minimum chip width so "19h45" fits even for very short movies. */
const MIN_CHIP_WIDTH = 36;

const ShowtimeChip: React.FC<ShowtimeChipProps> = ({
  showtime,
  cinemaName,
  color,
  runtimeHours,
  runtimeMinutes,
  hourToX,
}) => {
  const startX = hourToX(showtime.hour);
  const v = showtimeVersion(showtime.tags);

  // Use the showtime's own hour for display, NOT the chip's start position.
  const displayTime = formatTime(showtime.time);

  // Chip width = real duration, NOT clamped to the day strip width.
  // The chip extends to its real end time even if it overflows past the
  // last hour column. The container has overflow:visible (not hidden) so
  // the chip is fully visible.
  const realEndX = hourToX(showtime.hour + runtimeHours);
  const width = Math.max(MIN_CHIP_WIDTH, realEndX - startX - 2);

  return (
    <button
      type="button"
      disabled={!showtime.ticketingUrl}
      onClick={() => {
        if (showtime.ticketingUrl) {
          // CMB-008: route through the validated main-process handler.
          void window.electronAPI.openTicket(showtime.ticketingUrl);
        }
      }}
      onMouseDown={(e) => e.stopPropagation()} // don't start drag from a chip
      title={[
        cinemaName,
        formatTime(showtime.time),
        runtimeMinutes ? `${runtimeMinutes} min` : null,
        showtime.screen ? `${t('screen')}: ${showtime.screen}` : null,
        v ? `${t('version')}: ${v}` : null,
      ]
        .filter(Boolean)
        .join(' · ')}
      style={{
        position: 'absolute',
        top: '50%',
        transform: 'translateY(-50%)',
        left: startX + 1,
        width,
        padding: '4px 6px',
        background: color,
        color: 'var(--text-primary)',
        borderRadius: 4,
        fontSize: 11,
        fontWeight: 700,
        border: '1px solid rgba(255,255,255,0.15)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'flex-start',
        gap: 4,
        overflow: 'hidden',
        whiteSpace: 'nowrap' as const,
        boxSizing: 'border-box',
        cursor: showtime.ticketingUrl ? 'pointer' : 'default',
      }}
    >
      <span>{displayTime}</span>
      {v && width >= MIN_CHIP_WIDTH_FOR_BADGE && (
        <span
          style={{
            fontSize: 9,
            fontWeight: 700,
            background: 'rgba(0,0,0,0.4)',
            padding: '1px 4px',
            borderRadius: 2,
            flexShrink: 0,
          }}
        >
          {v}
        </span>
      )}
    </button>
  );
};

// ── Helpers for compact rating display in week view ──────────────────────

const acColorCompact = (score: number | undefined): string => {
  if (score === undefined) return 'var(--text-muted)';
  if (score >= 3.5) return '#10b981';
  if (score >= 2.5) return '#eab308';
  return '#e50914';
};

const scoreColorCompact = (score: number | undefined): string => {
  if (score === undefined) return 'var(--text-muted)';
  if (score >= 75) return '#10b981';
  if (score >= 60) return '#eab308';
  return '#e50914';
};
