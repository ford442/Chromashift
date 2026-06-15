import type { CollisionStats, RendererState } from './WebGPURenderer';
import type { ImageEntry } from './TextureManager';

export type RendererBackend = 'webgpu' | 'webgl';

export interface RenderTiming {
  lastCpuMs: number;
  averageCpuMs: number;
}

export interface ExportTracerOptions {
  width: number;
  height: number;
  tracerAboveOpacity: number;
  tracerBelowOpacity: number;
  tracerBlendMode: number;
  inspectZoom?: number;
  inspectPanX?: number;
  inspectPanY?: number;
  showHeatmap?: boolean;
  exposure?: number;
  applyTonemap?: boolean;
  showLayers?: boolean;
  layerBlendMode?: number;
  layerOpacity0?: number;
  layerOpacity1?: number;
  layerOpacity2?: number;
}

export interface ExportTracerResult {
  data: Uint8ClampedArray<ArrayBuffer>;
  width: number;
  height: number;
}

export interface ChromashiftRenderer {
  readonly backend: RendererBackend;
  setTexture(texture: unknown): void;
  setClassificationMaskTexture(texture: GPUTexture | null): void;
  setAntialiasing(enabled: boolean): void;
  clearPersistence(): void;
  render(state: RendererState, fps?: number): void;
  requestPreviewReadback(callback: (data: Uint8ClampedArray<ArrayBuffer>) => void): boolean;
  requestCollisionStats(callback: (stats: CollisionStats) => void): boolean;
  getRenderTiming(): RenderTiming;
  exportTracerView(options: ExportTracerOptions): Promise<ExportTracerResult | null>;
  destroy(): void;
}

export interface ChromashiftTextureManager {
  fetchImageList(endpoint: string): Promise<ImageEntry[]>;
  loadTexture(url: string): Promise<unknown>;
  uploadPixels(cacheKey: string, pixels: Uint8ClampedArray, width: number, height: number): unknown;
  destroy(): void;
}
