// Type declarations for scripts/cinema-monitor-issue.mjs.
export declare function buildFingerprint(
  results: ReadonlyArray<MonitorRow>,
): string;
export declare function diffFailureIds(
  prevResults: ReadonlyArray<MonitorRow>,
  nextResults: ReadonlyArray<MonitorRow>,
): { newFailures: string[]; resolved: string[] };
export declare function updateEmptyStreaks(
  prevBody: string,
  results: ReadonlyArray<MonitorRow>,
  today: string,
): Array<{ id: string; weeks: number; since: string; fresh: boolean }>;
export declare function buildIssueBody(
  report: { results: MonitorRow[]; runAt?: string },
  prevBody: string,
  today: string,
): string;
export declare interface MonitorRow {
  id: string;
  group: string;
  url: string;
  method: string;
  status: number | null;
  ms: number;
  verdict: 'ok' | 'warn' | 'blocked' | 'error';
  state: 'healthy' | 'degraded' | 'broken' | 'unknown' | null;
  stats?: { movies: number; days: number; showtimes: number; malformed: number };
  detail: string;
}
