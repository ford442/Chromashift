import type { CollisionStats } from './types/RendererState';

/**
 * Edge length of the downsampled frame collision stats are counted over, on
 * both backends.
 */
export const COLLISION_STATS_SIZE = 64;

/** What one sampled pixel says about the layers under it. */
export interface CollisionSample {
  /** 0–1 contribution to `averageCollision`. */
  collision: number;
  /** Not an overlap, two or more layers, or every layer. */
  overlap: 'none' | 'partial' | 'full';
  /** The layer that won the pixel, or `null` to count no win. */
  dominantLayer: number | null;
}

/**
 * Tally a `COLLISION_STATS_SIZE`² RGBA readback into `CollisionStats`. The
 * backends encode the frame differently (WebGPU blits the persistence
 * diagnostic, WebGL re-runs the compositor in heatmap view), so each brings its
 * own `decode`; the counting is shared.
 */
export function collisionStatsFromPixels(
  pixels: ArrayLike<number>,
  layerCount: number,
  decode: (r: number, g: number, b: number, a: number) => CollisionSample,
): CollisionStats {
  const stats: CollisionStats = {
    sampledPixels: COLLISION_STATS_SIZE * COLLISION_STATS_SIZE,
    twoOverlapPixels: 0,
    threeOverlapPixels: 0,
    dominantLayerWins: Array.from({ length: layerCount }, () => 0),
    averageCollision: 0,
  };
  let sum = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    const sample = decode(pixels[i], pixels[i + 1], pixels[i + 2], pixels[i + 3]);
    sum += sample.collision;
    if (sample.overlap === 'full') stats.threeOverlapPixels += 1;
    else if (sample.overlap === 'partial') stats.twoOverlapPixels += 1;
    if (sample.dominantLayer !== null) stats.dominantLayerWins[sample.dominantLayer] += 1;
  }
  stats.averageCollision = sum / stats.sampledPixels;
  return stats;
}

/**
 * The one collision-stats request a renderer serves at a time: a request is
 * refused while another is queued or still being read back.
 */
export class CollisionStatsRequest {
  private callback: ((stats: CollisionStats) => void) | null = null;
  /** Layer count the requested frame is rendered with. */
  layerCount = 3;

  /** Queue `callback`; `false` (and nothing queued) while another is outstanding. */
  request(callback: (stats: CollisionStats) => void, layerCount = 3): boolean {
    if (this.callback) return false;
    this.callback = callback;
    this.layerCount = Math.max(1, layerCount);
    return true;
  }

  get outstanding(): boolean {
    return this.callback !== null;
  }

  /** Deliver the stats and accept the next request. */
  settle(stats: CollisionStats): void {
    const callback = this.callback;
    this.callback = null;
    callback?.(stats);
  }

  /** Forget the request without an answer (the readback failed). */
  drop(): void {
    this.callback = null;
  }
}
