// ──────────────────────────────────────────────────────────────────────────
// Renderer-side re-exports.
//
// Domain types + helpers live in `src/shared/types.ts` so both the main
// process and the renderer use the same source of truth. This file exists
// only so existing component imports (`from '../types'`) keep working
// without a massive rename.
// ──────────────────────────────────────────────────────────────────────────

export type {
  Showtime,
  Movie,
  CinemaInfo,
  ScheduleResponse,
  CinemaStatus,
  AudioFilter,
} from '../../shared/types';
export {
  isVFShowtime,
  isVOShowtime,
  showtimeVersion,
  DEFAULT_RUNTIME_HOURS,
  TIMEZONE,
} from '../../shared/types';
