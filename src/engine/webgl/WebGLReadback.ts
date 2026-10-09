import { MAIN_VIEW_MODES } from '../viewModes';
import type { CollisionStats, RendererState } from '../types/RendererState';
import { PixelPackRead } from './asyncReadback';
import { createTarget, destroyTarget, readTargetPixels, type RenderTarget } from './resources';
import type { WebGLCompositorPass } from './WebGLCompositorPass';
import type { WebGLPersistencePass } from './WebGLPersistencePass';

export class WebGLReadback {
  static readonly PREVIEW_SIZE = 128;
  static readonly DIAGNOSTIC_SIZE = 64;

  private readonly gl: WebGL2RenderingContext;
  private previewTarget: RenderTarget | null = null;
  private diagnosticTarget: RenderTarget | null = null;
  private previewQueued: ((data: Uint8ClampedArray<ArrayBuffer>) => void) | null = null;
  private statsQueued: ((stats: CollisionStats) => void) | null = null;
  private readonly previewPack: PixelPackRead;
  private readonly statsPack: PixelPackRead;

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.previewPack = new PixelPackRead(gl);
    this.statsPack = new PixelPackRead(gl);
  }

  requestPreviewReadback(callback: (data: Uint8ClampedArray<ArrayBuffer>) => void): boolean {
    if (this.previewQueued) return false;
    this.previewQueued = callback;
    return true;
  }

  requestCollisionStats(callback: (stats: CollisionStats) => void): boolean {
    if (this.statsQueued) return false;
    this.statsQueued = callback;
    return true;
  }

  afterFrame(
    compositor: WebGLCompositorPass,
    layerTextures: readonly RenderTarget[],
    persistence: WebGLPersistencePass,
    state: RendererState,
    layerOpacities: number[],
  ): void {
    this.collectPreview();
    this.collectStats();
    if (this.previewQueued && !this.previewPack.busy) {
      this.previewTarget ??= createTarget(this.gl, WebGLReadback.PREVIEW_SIZE, WebGLReadback.PREVIEW_SIZE);
      compositor.render(this.previewTarget, WebGLReadback.PREVIEW_SIZE, WebGLReadback.PREVIEW_SIZE, layerTextures, persistence, {
        ...state,
        viewportQuarterZoom: false,
        viewportHalfOverlay: false,
      }, layerOpacities);
      this.previewPack.start(this.previewTarget, WebGLReadback.PREVIEW_SIZE, WebGLReadback.PREVIEW_SIZE);
    }
    if (this.statsQueued && !this.statsPack.busy) {
      this.diagnosticTarget ??= createTarget(this.gl, WebGLReadback.DIAGNOSTIC_SIZE, WebGLReadback.DIAGNOSTIC_SIZE);
      compositor.render(this.diagnosticTarget, WebGLReadback.DIAGNOSTIC_SIZE, WebGLReadback.DIAGNOSTIC_SIZE, layerTextures, persistence, {
        ...state,
        mainViewMode: MAIN_VIEW_MODES.COINCIDENCE_HEATMAP,
      }, layerOpacities);
      this.statsPack.start(this.diagnosticTarget, WebGLReadback.DIAGNOSTIC_SIZE, WebGLReadback.DIAGNOSTIC_SIZE);
    }
  }

  readTexturePixels(target: RenderTarget, width: number, height: number): Uint8ClampedArray<ArrayBuffer> {
    return readTargetPixels(this.gl, target, width, height);
  }

  /**
   * Pack `target` and resolve on a later frame. Export and the stationary
   * previews use this so a full-frame read does not freeze input.
   */
  async readTexturePixelsAsync(
    target: RenderTarget,
    width: number,
    height: number,
  ): Promise<Uint8ClampedArray<ArrayBuffer> | null> {
    const pack = new PixelPackRead(this.gl);
    try {
      pack.start(target, width, height);
      return await pack.wait();
    } finally {
      pack.destroy();
    }
  }

  destroy(): void {
    this.previewPack.destroy();
    this.statsPack.destroy();
    if (this.previewTarget) {
      destroyTarget(this.gl, this.previewTarget);
      this.previewTarget = null;
    }
    if (this.diagnosticTarget) {
      destroyTarget(this.gl, this.diagnosticTarget);
      this.diagnosticTarget = null;
    }
  }

  private collectPreview(): void {
    if (!this.previewQueued) return;
    const pixels = this.previewPack.poll();
    if (!pixels) return;
    const callback = this.previewQueued;
    this.previewQueued = null;
    callback(pixels);
  }

  private collectStats(): void {
    if (!this.statsQueued) return;
    const pixels = this.statsPack.poll();
    if (!pixels) return;
    const callback = this.statsQueued;
    this.statsQueued = null;
    callback(collisionStatsFromPixels(pixels));
  }

}

function collisionStatsFromPixels(pixels: Uint8ClampedArray<ArrayBuffer>): CollisionStats {
  const stats: CollisionStats = {
    sampledPixels: WebGLReadback.DIAGNOSTIC_SIZE * WebGLReadback.DIAGNOSTIC_SIZE,
    twoOverlapPixels: 0,
    threeOverlapPixels: 0,
    dominantLayerWins: [0, 0, 0],
    averageCollision: 0,
  };
  let sum = 0;
  for (let index = 0; index < pixels.length; index += 4) {
    const r = pixels[index];
    const g = pixels[index + 1];
    const b = pixels[index + 2];
    const hit = Math.max(r, g, b) / 255;
    sum += hit;
    if (r > 200 && g > 170) stats.threeOverlapPixels += 1;
    else if (b > 180 || g > 150) stats.twoOverlapPixels += 1;
    if (r >= g && r >= b) stats.dominantLayerWins[0] += 1;
    else if (g >= b) stats.dominantLayerWins[1] += 1;
    else stats.dominantLayerWins[2] += 1;
  }
  stats.averageCollision = sum / stats.sampledPixels;
  return stats;
}
