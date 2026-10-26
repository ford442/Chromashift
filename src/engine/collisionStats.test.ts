import { describe, expect, it, vi } from 'vitest';
import {
  COLLISION_STATS_SIZE,
  CollisionStatsRequest,
  collisionStatsFromPixels,
  type CollisionSample,
} from './collisionStats';

const PIXELS = COLLISION_STATS_SIZE * COLLISION_STATS_SIZE;

describe('collisionStatsFromPixels', () => {
  it('counts overlaps and wins per decoded pixel, averaged over the whole sample', () => {
    const pixels = new Uint8Array(PIXELS * 4);
    // Pixel 0: full overlap won by layer 2; pixel 1: partial, layer 0; the rest empty.
    pixels.set([2, 0, 0, 255], 0);
    pixels.set([0, 0, 0, 128], 4);
    const decode = (r: number, _g: number, _b: number, a: number): CollisionSample => ({
      collision: a / 255,
      overlap: a === 255 ? 'full' : a > 0 ? 'partial' : 'none',
      dominantLayer: a > 0 ? r : null,
    });

    const stats = collisionStatsFromPixels(pixels, 4, decode);

    expect(stats).toEqual({
      sampledPixels: PIXELS,
      threeOverlapPixels: 1,
      twoOverlapPixels: 1,
      dominantLayerWins: [1, 0, 1, 0],
      averageCollision: (1 + 128 / 255) / PIXELS,
    });
  });
});

describe('CollisionStatsRequest', () => {
  it('serves one request at a time', () => {
    const request = new CollisionStatsRequest();
    const first = vi.fn();
    expect(request.request(first, 5)).toBe(true);
    expect(request.layerCount).toBe(5);
    expect(request.request(vi.fn())).toBe(false);

    const stats = collisionStatsFromPixels(new Uint8Array(0), 5, () => ({ collision: 0, overlap: 'none', dominantLayer: null }));
    request.settle(stats);
    expect(first).toHaveBeenCalledWith(stats);
    expect(request.outstanding).toBe(false);
    expect(request.request(vi.fn())).toBe(true);
  });

  it('accepts a new request after a dropped one, without answering it', () => {
    const request = new CollisionStatsRequest();
    const dropped = vi.fn();
    request.request(dropped);
    request.drop();
    expect(request.request(vi.fn())).toBe(true);
    expect(dropped).not.toHaveBeenCalled();
  });
});
