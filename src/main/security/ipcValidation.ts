// ──────────────────────────────────────────────────────────────────────────
// IPC input validation boundary (review IPC-01).
//
// TypeScript casts (`as Movie[]`) do not validate runtime input. Every
// privileged main-process handler behind a renderer message now parses its
// input here: fail-closed shape checks, size caps, allow-listed fields —
// and the handlers pass only the sanitized result into application logic.
//
// These helpers are electron-free so they are unit-testable; the wiring is
// pinned by src contract checks (test/main/securityContract.test.ts).
//
// Not covered here (deliberately): sender-origin checks — those need the
// electron event object and stay inline in index.ts
// (isKnownRendererSender()), with a header comment pinning the rule.
// ──────────────────────────────────────────────────────────────────────────

import type { Movie } from '../../shared/types';

export type ParseResult<T> = { ok: true; value: T } | { ok: false; reason: string };

/** 1..64 of [A-Za-z0-9_-] — ids are slugs/numeric strings everywhere. */
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

const MAX_CINEMA_IDS = 100;
const MAX_RETRY_MOVIES = 1000;

/**
 * Validate the optional `cinemaIds` argument of schedule:fetch.
 * Unknown-but-conforming ids are NOT an error — the handler intersects
 * with the registered cinemas — but anything non-conforming rejects the
 * whole request: malformed input should never reach application logic.
 */
export function parseCinemaIdsInput(input: unknown): ParseResult<string[]> {
  if (input === undefined || input === null) return { ok: true, value: [] };
  if (!Array.isArray(input)) return { ok: false, reason: `cinemaIds must be an array, got ${typeof input}` };
  if (input.length > MAX_CINEMA_IDS) {
    return { ok: false, reason: `cinemaIds array too large (${input.length} > ${MAX_CINEMA_IDS})` };
  }
  for (const id of input) {
    if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
      return { ok: false, reason: `cinemaIds contains a non-conforming id: ${JSON.stringify(id)}` };
    }
  }
  return { ok: true, value: input as string[] };
}

export interface RetryMovieLight extends Movie {
  showtimes: [];
}

/**
 * Validate + sanitize the `ratings:retry` movies array. Produces a
 * bounded Movie-lite: only known, benign fields survive — the handler
 * never receives a raw renderer-crafted object that could carry
 * unexpected keys (prototype pollution vectors, fake adapter configs…).
 * Structurally-broken movies are dropped from the list (not silently
 * re-cast); if NONE survive, the caller gets a failure reason.
 */
export function parseRetryMoviesInput(
  input: unknown,
  knownCinemaIds: ReadonlySet<string>,
  sanitizeString: (value: unknown, max: number) => string,
): ParseResult<RetryMovieLight[]> {
  if (!Array.isArray(input)) return { ok: false, reason: `expected an array of movies, got ${typeof input}` };
  if (input.length > MAX_RETRY_MOVIES) {
    return { ok: false, reason: `movies array too large (${input.length} > ${MAX_RETRY_MOVIES})` };
  }
  const out: RetryMovieLight[] = [];
  for (const m of input) {
    if (m === null || typeof m !== 'object' || Array.isArray(m)) continue;
    const raw = m as Record<string, unknown>;
    const id = typeof raw.id === 'string' && ID_PATTERN.test(raw.id) ? raw.id : null;
    const cinemaId =
      typeof raw.cinemaId === 'string' && ID_PATTERN.test(raw.cinemaId) ? raw.cinemaId : null;
    // Only retry movies whose cinema we actually serve — a forged
    // cinemaId cannot smuggle an unknown context into logging/pipeline.
    const title = sanitizeString(raw.title, 400);
    if (!id || !cinemaId || !knownCinemaIds.has(cinemaId) || !title) continue;

    const release =
      typeof raw.release === 'string' && /^\d{4}-\d{2}-\d{2}/.test(raw.release)
        ? raw.release
        : undefined;

    out.push({
      id,
      cinemaId,
      title,
      release,
      direction: sanitizeString(raw.direction, 300) || '',
      casting: sanitizeString(raw.casting, 600) || '',
      poster: sanitizeString(raw.poster, 2048) || undefined,
      hasVF: raw.hasVF === true,
      hasVO: raw.hasVO === true,
      showtimes: [],
      // Rating state the retry needs — bounded strings/numbers only.
      imdbStatus: parseStatus(raw.imdbStatus),
      allocineStatus: parseStatus(raw.allocineStatus),
      rtStatus: parseStatus(raw.rtStatus),
      imdbId: typeof raw.imdbId === 'string' && /^tt\d{5,10}$/.test(raw.imdbId) ? raw.imdbId : undefined,
      wikidataUrl: sanitizeString(raw.wikidataUrl, 512) || undefined,
    } as RetryMovieLight);
  }
  if (out.length === 0) {
    return { ok: false, reason: 'no structurally-valid movies in the retry list' };
  }
  return { ok: true, value: out };
}

function parseStatus(v: unknown): 'ok' | 'absent' | 'blocked' | undefined {
  return v === 'ok' || v === 'absent' || v === 'blocked' ? v : undefined;
}

/** Evaluator injected by the caller (avoids importing renderer/i18n here). */
export function defaultSanitizeString(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  return value.slice(0, max).replace(/[\u0000-\u001f\u007f]/g, '');
}
