// ──────────────────────────────────────────────────────────────────────────
// ipcRegistrar tests — the electron IPC boundary (ARCH-01).
//
// index.ts can't be imported in vitest, but the registrar CAN: electron is
// mocked (ipcMain.handle captured into a map, BrowserWindow fake windows,
// shell spy), and the registry/adapter/fetcher collaborators are mocked.
// What is pinned:
//   - the full channel list is registered (exactly once each) — a channel
//     silently dropped by a refactor fails here;
//   - schedule:fetch boundary behavior (sender check, validation,
//     aggregation via the real scheduleService);
//   - ratings:retry boundary behavior (garbage → zeros; valid → sanitized
//     movies forwarded + broadcasts);
//   - tickets:open protocol allow-list;
//   - cinemas:save-custom triggers notifyCinemasChanged.
// ──────────────────────────────────────────────────────────────────────────

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const h = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const sent: Array<{ win: number; channel: string; payload: unknown }> = [];
  const fakeWindows = [
    { webContents: { send: (channel: string, payload: unknown) => sent.push({ win: 0, channel, payload }) } },
    { webContents: { send: (channel: string, payload: unknown) => sent.push({ win: 1, channel, payload }) } },
  ];
  const openExternal = vi.fn(async () => undefined);
  const fetchSchedule1 = vi.fn(async () => ({
    availableDays: ['2026-01-01'],
    movies: [{ id: 'm1', cinemaId: 'cluses', title: 'Film A', showtimes: [], hasVF: true, hasVO: false }],
  }));
  const fetchSchedule2 = vi.fn(async () => ({
    availableDays: ['2026-01-01', '2026-01-02'],
    movies: [{ id: 'm2', cinemaId: 'c2', title: 'Film A', showtimes: [], hasVF: true, hasVO: false }],
  }));
  const saveCustom = vi.fn(() => ({
    written: true,
    reload: { registered: ['cluses'], errors: [] },
  }));
  const retryFailedLookups = vi.fn(
    async (..._args: unknown[]): Promise<{ retried: number; succeeded: number; stillFailing: number }> => ({
      retried: 1,
      succeeded: 1,
      stillFailing: 0,
    }),
  );
  const invalidateRatingsCaches = vi.fn(() => 7);
  return {
    handlers,
    sent,
    fakeWindows,
    openExternal,
    fetchSchedule1,
    fetchSchedule2,
    saveCustom,
    retryFailedLookups,
    invalidateRatingsCaches,
  };
});

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => '/tmp/arvecinema-test' },
  BrowserWindow: { getAllWindows: () => h.fakeWindows },
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => {
      if (h.handlers.has(channel)) throw new Error(`duplicate registration: ${channel}`);
      h.handlers.set(channel, fn);
    },
  },
  shell: { openExternal: h.openExternal },
}));

vi.mock('../../../src/main/cinemas/registry', () => ({
  CINEMAS: [
    { id: 'cluses', name: 'C', city: '', color: '', adapter: { fetchSchedule: h.fetchSchedule1 } },
    { id: 'c2', name: 'C2', city: '', color: '', adapter: { fetchSchedule: h.fetchSchedule2 } },
  ],
  getCinemaInfos: () => [{ id: 'cluses' }, { id: 'c2' }],
  loadCustomCinemas: () => ({ registered: [], errors: [] }),
}));
vi.mock('../../../src/main/cinemas/customCinemasIpc', () => ({
  readCustomCinemasFile: () => ({ path: 'x', exists: false, cinemas: [] }),
  saveCustomCinemas: h.saveCustom,
}));
vi.mock('../../../src/main/cinemas/adapters', () => ({ listPlugins: () => [{ kind: 'replay' }] }));
vi.mock('../../../src/main/ratings/ratingsEnricher', () => ({
  // Phase-0 semantics: synchronous in-place enrichment before returning.
  enrichWithRatings: async (movies: Array<Record<string, unknown>>, onUpdated: (m: unknown) => void) => {
    for (const m of movies) m.imdbRating = 8.0;
    onUpdated(movies[0]);
  },
}));
vi.mock('../../../src/main/ratings/ratingsFetcher', () => ({
  retryFailedLookups: h.retryFailedLookups,
  invalidateRatingsCaches: h.invalidateRatingsCaches,
}));
vi.mock('../../../src/main/ratings/logger', () => ({
  getAllLogs: () => [] as string[],
  clearLogs: () => undefined,
  getComponentLogger: () => ({
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  }),
  initLogging: () => undefined,
}));

import { registerIpcHandlers } from '../../../src/main/services/ipcRegistrar';

type Handler = (evt?: unknown, payload?: unknown) => Promise<unknown>;
/** Typed accessor for a captured channel handler (fails the test if missing). */
const call = (channel: string): Handler => {
  const fn = h.handlers.get(channel);
  if (!fn) throw new Error(`channel not registered: ${channel}`);
  return fn as Handler;
};

const EXPECTED_CHANNELS = [
  'cinemas:list',
  'cinemas:read-custom',
  'cinemas:save-custom',
  'cinemas:plugin-kinds',
  'cinemas:reload-custom',
  'schedule:fetch',
  'dev:export-all',
  'ratings:retry',
  'ratings:invalidate-cache',
  'tickets:open',
  'dev:get-network-state',
  'log:get-all',
  'log:clear',
];

const senderEvent = { sender: h.fakeWindows[0].webContents };

beforeEach(() => {
  h.handlers.clear();
  h.sent.length = 0;
  h.openExternal.mockClear();
  h.fetchSchedule1.mockClear();
  h.fetchSchedule2.mockClear();
  h.saveCustom.mockClear();
  h.retryFailedLookups.mockClear();
  h.invalidateRatingsCaches.mockClear();
  registerIpcHandlers({ customCinemasFile: () => 'custom.json', notifyCinemasChanged: vi.fn() });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('ipcRegistrar: registration completeness', () => {
  it('registers every channel exactly once', () => {
    expect([...h.handlers.keys()].sort()).toEqual([...EXPECTED_CHANNELS].sort());
  });
});

describe('ipcRegistrar: schedule:fetch', () => {
  it('aggregates cinemas through the service and broadcasts phase-0 updates', async () => {
    const res = (await call('schedule:fetch')(senderEvent)) as {
      movies: Array<{ id: string }>;
      availableDays: string[];
      cinemaStatuses: Array<{ cinemaId: string; status: string }>;
    };
    expect(res.movies.map((m) => m.id)).toEqual(['m2', 'm1']); // tie on title → cinemaId sort: 'c2' < 'cluses'
    expect(res.availableDays).toEqual(['2026-01-01', '2026-01-02']);
    expect(res.cinemaStatuses.map((s) => s.status)).toEqual(['ok', 'ok']);
    expect(res.movies[0]).toHaveProperty('imdbRating', 8.0); // phase-0 applied in place
  });

  it('broadcasts to every renderer window (2 windows × 1 updated movie)', async () => {
    const res = (await call('schedule:fetch')(senderEvent)) as { movies: unknown[] };
    void res;
    const ratingSends = h.sent.filter((s) => s.channel === 'rating:updated');
    expect(ratingSends).toHaveLength(2); // two windows, one movie enriched
    expect(new Set(ratingSends.map((s) => s.win))).toEqual(new Set([0, 1]));
  });

  it('rejects malformed cinemaIds whole-request', async () => {
    await expect(call('schedule:fetch')(senderEvent, [42])).rejects.toThrow(/schedule:fetch/);
    expect(h.fetchSchedule1).not.toHaveBeenCalled();
  });

  it('rejects unknown senders', async () => {
    await expect(call('schedule:fetch')({ sender: {} })).rejects.toThrow(/unexpected sender/);
    expect(h.fetchSchedule1).not.toHaveBeenCalled();
  });

  it('respects the enabled-cinema filter', async () => {
    await call('schedule:fetch')(senderEvent, ['c2']);
    expect(h.fetchSchedule2).toHaveBeenCalledWith(14);
    expect(h.fetchSchedule1).not.toHaveBeenCalled();
  });
});

describe('ipcRegistrar: ratings:retry', () => {
  const validMovie = {
    id: 'm1',
    cinemaId: 'cluses',
    title: 'Film A',
    hasVF: true,
    hasVO: false,
    imdbStatus: 'blocked',
  };

  it('forwards ONLY sanitized movies to the fetcher and broadcasts updates', async () => {
    const res = (await call('ratings:retry')(senderEvent, [validMovie])) as {
      retried: number;
      succeeded: number;
    };
    expect(res).toEqual({ retried: 1, succeeded: 1, stillFailing: 0 });
    expect(h.retryFailedLookups).toHaveBeenCalledTimes(1);
    const passed = (h.retryFailedLookups.mock.calls[0][0] as Array<Record<string, unknown>>)[0];
    expect(passed.id).toBe('m1');
    expect(passed.cinemaId).toBe('cluses');
    expect(Object.keys(passed)).not.toContain('extra'); // whitelist
  });

  it('non-array / no-valid-movie payloads return zeros without touching the fetcher', async () => {
    for (const bad of [undefined, 'movies', [], [{ id: 3 }]]) {
      const res = (await call('ratings:retry')(senderEvent, bad)) as { retried: number };
      expect(res.retried).toBe(0);
    }
    expect(h.retryFailedLookups).not.toHaveBeenCalled();
  });

  it('unknown senders are rejected', async () => {
    const res = (await call('ratings:retry')({ sender: {} }, [validMovie])) as {
      retried: number;
    };
    expect(res.retried).toBe(0);
    expect(h.retryFailedLookups).not.toHaveBeenCalled();
  });
});

describe('ipcRegistrar: ratings:invalidate-cache', () => {
  it('delegates to invalidateRatingsCaches and returns the row count', async () => {
    const res = (await call('ratings:invalidate-cache')(senderEvent)) as { cleared: number };
    expect(res).toEqual({ cleared: 7 });
    expect(h.invalidateRatingsCaches).toHaveBeenCalledTimes(1);
  });

  it('unknown senders are rejected (a forged call must not wipe the cache)', async () => {
    const res = (await call('ratings:invalidate-cache')({ sender: {} })) as { cleared: number };
    expect(res).toEqual({ cleared: 0 });
    expect(h.invalidateRatingsCaches).not.toHaveBeenCalled();
  });
});

describe('ipcRegistrar: tickets:open', () => {
  it('opens https URLs, rejects other protocols and garbage', async () => {
    expect(await call('tickets:open')(senderEvent, 'https://billetterie.fr/x')).toBe(true);
    expect(h.openExternal).toHaveBeenCalledWith('https://billetterie.fr/x');
    expect(await call('tickets:open')(senderEvent, 'javascript:alert(1)')).toBe(false);
    expect(h.openExternal).toHaveBeenCalledTimes(1);
    expect(await call('tickets:open')(senderEvent, '')).toBe(false);
    expect(await call('tickets:open')(senderEvent, 42)).toBe(false);
  });
});

describe('ipcRegistrar: cinemas channels', () => {
  it('save-custom delegates to the file module and notifies the renderers', async () => {
    const res = (await call('cinemas:save-custom')(senderEvent, [])) as { written: boolean };
    expect(res.written).toBe(true);
    expect(h.saveCustom).toHaveBeenCalledWith('custom.json', []);
  });

  it('metadata channels expose round data only', () => {
    expect(call('cinemas:list')()).toEqual([{ id: 'cluses' }, { id: 'c2' }]);
    expect(call('cinemas:plugin-kinds')()).toEqual([{ kind: 'replay' }]);
  });
});
