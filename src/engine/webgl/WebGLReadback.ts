import type { CollisionStats } from '../types/RendererState';
import { COLLISION_STATS_SIZE, CollisionStatsRequest, collisionStatsFromPixels, type CollisionSample } from '../collisionStats';
import { PixelPackRead, readTargetPixelsAsync } from './asyncReadback';
import { createTarget, destroyTarget, readTargetPixels, type RenderTarget } from './resources';

/**
 * Draws the frame's coincidence heatmap into `target` (the graph's compositor,
 * re-run in heatmap view). `false` when there is no frame to draw it from.
 */
export type HeatmapDraw = (target: RenderTarget, size: number) => boolean;

export class WebGLReadback {
  static readonly DIAGNOSTIC_SIZE = COLLISION_STATS_SIZE;

  private readonly gl: WebGL2RenderingContext;
  private diagnosticTarget: RenderTarget | null = null;
  private readonly stats = new CollisionStatsRequest();
  private readonly statsPack: PixelPackRead;

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.statsPack = new PixelPackRead(gl);
  }

  requestCollisionStats(callback: (stats: CollisionStats) => void): boolean {
    return this.stats.request(callback);
  }

  afterFrame(drawHeatmap: HeatmapDraw): void {
    this.collectStats();
    if (this.stats.outstanding && !this.statsPack.busy) {
      const size = WebGLReadback.DIAGNOSTIC_SIZE;
      this.diagnosticTarget ??= createTarget(this.gl, size, size);
      if (drawHeatmap(this.diagnosticTarget, size)) {
        this.statsPack.start(this.diagnosticTarget, size, size);
      }
    }
  }

  readTexturePixels(target: RenderTarget, width: number, height: number): Uint8ClampedArray<ArrayBuffer> {
    return readTargetPixels(this.gl, target, width, height);
  }

  /**
   * Pack `target` and resolve on a later frame. Export and the stationary
   * previews use this so a full-frame read does not freeze input.
   */
  readTexturePixelsAsync(
    target: RenderTarget,
    width: number,
    height: number,
  ): Promise<Uint8ClampedArray<ArrayBuffer> | null> {
    return readTargetPixelsAsync(this.gl, target, width, height);
  }

  destroy(): void {
    this.statsPack.destroy();
    if (this.diagnosticTarget) {
      destroyTarget(this.gl, this.diagnosticTarget);
      this.diagnosticTarget = null;
    }
  }

  private collectStats(): void {
    if (!this.stats.outstanding) return;
    const pixels = this.statsPack.poll();
    if (!pixels) return;
    this.stats.settle(collisionStatsFromPixels(pixels, 3, decodeHeatmap));
  }
}

/** The coincidence heatmap's colours: hotter and yellower where more layers overlap. */
function decodeHeatmap(r: number, g: number, b: number): CollisionSample {
  return {
    collision: Math.max(r, g, b) / 255,
    overlap: r > 200 && g > 170 ? 'full' : b > 180 || g > 150 ? 'partial' : 'none',
    dominantLayer: r >= g && r >= b ? 0 : g >= b ? 1 : 2,
  };
}
