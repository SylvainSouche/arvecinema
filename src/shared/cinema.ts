// ──────────────────────────────────────────────────────────────────────────
// Shared cinema-domain helpers used by both the main process (adapters) and
// the renderer (filtering, formatting).
// ──────────────────────────────────────────────────────────────────────────

import { TIMEZONE } from './types';
import type { CinemaInfo } from './types';

// ── Date / hour helpers ──────────────────────────────────────────────────

/**
 * Parse a YYYY-MM-DD as noon UTC — safe for formatting in any timezone.
 *
 * Used for cinema-domain dates that are timezone-less (e.g. `day` fields
 * stored as "2026-09-09"). Parsing `new Date('2026-09-09T00:00:00')` would
 * interpret midnight in HOST local time, then re-projecting to Europe/Paris
 * can shift the calendar date by one day on hosts east of UTC+3. Noon UTC
 * is far enough from any DST boundary that the projection is always stable.
 *
 * BUG-03 fix.
 */
export const parseIsoDay = (iso: string): Date => new Date(`${iso}T12:00:00Z`);

/** Parse a possibly-malformed showtime timestamp into a Date, or null.
 *
 *  BUG-01 fix: `new Date(undefined)` returns Invalid Date, and `Intl.DateTimeFormat.formatToParts`
 *  throws on Invalid Date rather than returning "Invalid Date". Without this
 *  guard, one bad `startsAt` field would crash the whole cinema's fetch.
 */
export const parseShowtimeDate = (raw: unknown): Date | null => {
  if (typeof raw !== 'string' || !raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
};

/** Format a Date as YYYY-MM-DD in the configured timezone. */
export const toIsoDay = (d: Date): string => {
  // Use Intl with the cinema timezone so the result is correct regardless
  // of the host machine's local timezone.
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIMEZONE,
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(d);
  const y = parts.find(p => p.type === 'year')!.value;
  const m = parts.find(p => p.type === 'month')!.value;
  const day = parts.find(p => p.type === 'day')!.value;
  return `${y}-${m}-${day}`;
};

/** Today's YYYY-MM-DD in Europe/Paris. */
export const todayIso = (): string => toIsoDay(new Date());

/**
 * Format an ISO 8601 local time as "HHhMM" in Europe/Paris.
 *   "2026-09-09T19:45:00" → "19h45"
 */
export const formatTime = (iso: string): string => {
  const s = new Date(iso).toLocaleTimeString('fr-FR', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: TIMEZONE,
  });
  return s.replace(':', 'h');
};

/**
 * Format an hour float as "HHhMM".
 *   19.75 → "19h45"
 *   19.999 → "20h00"   (rounds up cleanly)
 */
export const formatHour = (h: number): string => {
  const hh = Math.floor(h);
  const mm = Math.round((h - hh) * 60);
  if (mm >= 60) {
    return `${String(hh + 1).padStart(2, '0')}h00`;
  }
  return `${String(hh).padStart(2, '0')}h${String(mm).padStart(2, '0')}`;
};

/**
 * Format a YYYY-MM-DD string as a short French weekday + day number + month.
 *   "2026-09-09" → { weekday: "Mer", dayNum: "09", month: "sep" }
 *
 * BUG-03 fix: parse as noon UTC, then format in UTC (the calendar date is
 * already resolved, we just need to render the labels). This is stable on
 * any host timezone — previously parsed as host-local midnight and then
 * re-projected to Europe/Paris, which shifted the date by one day on
 * hosts east of UTC+3.
 */
export const formatDayShort = (iso: string): {
  weekday: string;
  dayNum: string;
  month: string;
} => {
  const d = parseIsoDay(iso);
  // timeZone: 'UTC' because we already have the correct calendar date and
  // just want to render its components without further projection.
  const opts = { timeZone: 'UTC' as const };
  const weekday = d.toLocaleDateString('fr-FR', { weekday: 'short', ...opts }).replace('.', '');
  const dayNum = d.toLocaleDateString('fr-FR', { day: '2-digit', ...opts });
  const month = d.toLocaleDateString('fr-FR', { month: 'short', ...opts }).replace('.', '');
  return { weekday, dayNum, month };
};

// ── Cinema lookup helpers ─────────────────────────────────────────────────

/** Returns the cinema's color, or a neutral gray if not found. */
export const cinemaColor = (cinemas: CinemaInfo[], id: string): string =>
  cinemas.find(c => c.id === id)?.color ?? '#888';

/** Returns the cinema's display name, or the raw id if not found. */
export const cinemaName = (cinemas: CinemaInfo[], id: string): string =>
  cinemas.find(c => c.id === id)?.name ?? id;

// ── Search normalization ──────────────────────────────────────────────────

/**
 * Normalize a string for case-insensitive + accent-insensitive matching.
 *   "Quentin Tarantino" → "quentin tarantino"
 *   "Réalisateur"        → "realisateur"
 */
export const normalize = (s: string): string =>
  s.toLowerCase()
    .replace(/[\u2018\u2019\u201b]/g, "'")   // normalize curly apostrophes to straight
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '');

// ── French weekday helpers (used by the cinechateau HTML scraper) ──────────

/** French weekday abbreviations, indexed by Date.getDay() (0 = Sunday). */
export const WEEKDAY_FR = ['dim', 'lun', 'mar', 'mer', 'jeu', 'ven', 'sam'];
