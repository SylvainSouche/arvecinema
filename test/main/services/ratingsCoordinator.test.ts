// ──────────────────────────────────────────────────────────────────────────
// ratingsCoordinator tests — retry orchestration (ARCH-01). The injected
// retry seam means no ratingsFetcher/network is touched; the point is that
// each updated movie is correctly mapped to a `rating:updated` broadcast.
// ──────────────────────────────────────────────────────────────────────────

import { describe, it, expect, vi } from 'vitest';
import {
  retryBlockedLookups,
  type RetryFn,
} from '../../../src/main/services/ratingsCoordinator';
import { movieToRatingUpdate } from '../../../src/main/services/ratingUpdates';
import type { Movie } from '../../../src/main/cinemas/types';

const movie = (id: string): Movie =>
  ({
    id,
    cinemaId: 'cluses',
    title: 'Film',
    showtimes: [],
    hasVF: true,
    hasVO: false,
    imdbStatus: 'blocked',
  }) as unknown as Movie;

describe('retryBlockedLookups', () => {
  it('publishes each updated movie as a complete rating:updated message', async () => {
    const published: unknown[] = [];
    const retry: RetryFn = async (movies, onUpdated) => {
      expect(movies.map((m) => m.id)).toEqual(['m1', 'm2']); // sanitized movies forwarded as-is
      onUpdated(movie('m1'));
      onUpdated(movie('m2'));
      return { retried: 2, succeeded: 1, stillFailing: 1 };
    };
    const summary = await retryBlockedLookups([movie('m1'), movie('m2')], {
      publish: (msg) => published.push(msg),
      retry,
    });
    expect(summary).toEqual({ retried: 2, succeeded: 1, stillFailing: 1 });
    expect(published).toEqual([movieToRatingUpdate(movie('m1')), movieToRatingUpdate(movie('m2'))]);
  });

  it('produces zero publishes when the retry finds nothing blocked', async () => {
    const published: unknown[] = [];
    const retry: RetryFn = vi.fn(async () => ({ retried: 0, succeeded: 0, stillFailing: 0 }));
    const summary = await retryBlockedLookups([movie('m1')], {
      publish: (m) => published.push(m),
      retry,
    });
    expect(summary.retried).toBe(0);
    expect(published).toEqual([]);
  });

  it('propagates retry failures to the caller (no swallow)', async () => {
    const retry: RetryFn = async () => {
      throw new Error('fetcher exploded');
    };
    await expect(
      retryBlockedLookups([movie('m1')], { publish: () => undefined, retry }),
    ).rejects.toThrow('fetcher exploded');
  });
});
