// Type declarations for scripts/scrape-probe.mjs (imported by its contract
// test). The probe is plain ESM JavaScript so it can run on bare Node in CI
// without a build step.
export declare function buildUserAgent(version: string): string;
export declare interface ProbeTarget {
  id: string;
  group: 'cinemas' | 'ratings';
  url: string;
  method?: 'GET' | 'HEAD';
  headers: Record<string, string>;
  /** 'ok' = plain HTTP must succeed; 'browser-ok' = browser-only source
   *  (plain-fetch 403 is a warn, not a block verdict). */
  expect: 'ok' | 'browser-ok';
}
export declare function buildProbeTargets(
  cinemas: ReadonlyArray<{
    id: string;
    adapter: { kind: string; baseUrl: string; theaterId?: string };
  }>,
): ProbeTarget[];
export declare interface ProbeResult {
  id: string;
  group: string;
  url: string;
  method: string;
  status: number | null;
  ms: number;
  verdict: 'ok' | 'warn' | 'blocked' | 'error';
  detail: string;
}
export declare function runProbe(
  targets: ReadonlyArray<ProbeTarget>,
  deps: {
    fetchImpl: (url: string, init: Record<string, unknown>) => Promise<{ status: number }>;
    timeoutMs: number;
    userAgent: string;
  },
): Promise<{ ok: boolean; results: ProbeResult[] }>;
