import type { CinemaInfo, ScheduleResponse } from '../types';

export const fetchCinemas = (): Promise<CinemaInfo[]> =>
  window.electronAPI.fetchCinemas();

export const fetchSchedule = (cinemaIds?: string[]): Promise<ScheduleResponse> =>
  window.electronAPI.fetchSchedule(cinemaIds);
