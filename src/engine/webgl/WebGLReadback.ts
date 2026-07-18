import { MAIN_VIEW_MODES } from '../viewModes';
import type { CollisionStats, RendererState } from '../types/RendererState';
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

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
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
    layerOpacities: [number, number, number],
  ): void {
    if (this.previewQueued) {
      this.previewTarget ??= createTarget(this.gl, WebGLReadback.PREVIEW_SIZE, WebGLReadback.PREVIEW_SIZE);
      compositor.render(this.previewTarget, WebGLReadback.PREVIEW_SIZE, WebGLReadback.PREVIEW_SIZE, layerTextures, persistence, {
        ...state,
        viewportQuarterZoom: false,
        viewportHalfOverlay: false,
      }, layerOpacities);
      this.readPreview();
    }
    if (this.statsQueued) {
      this.diagnosticTarget ??= createTarget(this.gl, WebGLReadback.DIAGNOSTIC_SIZE, WebGLReadback.DIAGNOSTIC_SIZE);
      compositor.render(this.diagnosticTarget, WebGLReadback.DIAGNOSTIC_SIZE, WebGLReadback.DIAGNOSTIC_SIZE, layerTextures, persistence, {
        ...state,
        mainViewMode: MAIN_VIEW_MODES.COINCIDENCE_HEATMAP,
      }, layerOpacities);
      this.readStats();
    }
  }

  readTexturePixels(target: RenderTarget, width: number, height: number): Uint8ClampedArray<ArrayBuffer> {
    return readTargetPixels(this.gl, target, width, height);
  }

  destroy(): void {
    if (this.previewTarget) {
      destroyTarget(this.gl, this.previewTarget);
      this.previewTarget = null;
    }
    if (this.diagnosticTarget) {
      destroyTarget(this.gl, this.diagnosticTarget);
      this.diagnosticTarget = null;
    }
  }

  private readPreview(): void {
    if (!this.previewTarget || !this.previewQueued) return;
    const callback = this.previewQueued;
    this.previewQueued = null;
    callback(this.readTexturePixels(this.previewTarget, WebGLReadback.PREVIEW_SIZE, WebGLReadback.PREVIEW_SIZE));
  }

  private readStats(): void {
    if (!this.diagnosticTarget || !this.statsQueued) return;
    const callback = this.statsQueued;
    this.statsQueued = null;
    const pixels = this.readTexturePixels(this.diagnosticTarget, WebGLReadback.DIAGNOSTIC_SIZE, WebGLReadback.DIAGNOSTIC_SIZE);
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
    callback(stats);
  }
}
