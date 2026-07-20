import type { CollisionStats, RendererState } from './RendererState';
import type { ImageEntry } from '../TextureManager';
import type { StationaryPreviewOptions, StationaryPreviewResult } from '../stationaryPreview';

export type RendererBackend = 'webgpu' | 'webgl';

export interface GpuPassTimings {
  layersMs: number;
  persistenceMs: number;
  compositorMs: number;
  readbackMs: number;
  totalGpuMs: number;
}

export interface GpuRenderTiming {
  available: boolean;
  last: GpuPassTimings | null;
  /** Total GPU frame time per frame (up to 120 samples). */
  history: readonly number[];
  approxBandwidthMBps: number;
}

export const EMPTY_GPU_RENDER_TIMING: GpuRenderTiming = {
  available: false,
  last: null,
  history: [],
  approxBandwidthMBps: 0,
};

export interface RenderTiming {
  lastCpuMs: number;
  averageCpuMs: number;
  gpu: GpuRenderTiming;
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

/** Which render pass to capture during offline video export. */
export type ExportPassMode = 'composite' | 'tracers' | 'layers';

export interface ExportFrameOptions {
  width: number;
  height: number;
  /** Target pass; defaults to `composite`. */
  passMode?: ExportPassMode;
  /** Frame rate used for tracer decay during export. */
  fps?: number;
}

export type ExportFrameResult = ExportTracerResult;

export interface ChromashiftRenderer {
  readonly backend: RendererBackend;
  setTexture(texture: unknown): void;
  setClassificationMaskTexture(texture: GPUTexture | null): void;
  setAntialiasing(enabled: boolean): void;
  clearPersistence(): void;
  render(state: RendererState, fps?: number): void;
  /** Stationary side previews at panel preset angles (Original/Separated/Tracer strip). */
  renderStationaryPreviews(
    state: RendererState,
    options?: StationaryPreviewOptions,
  ): Promise<StationaryPreviewResult>;
  /** @deprecated Side previews use {@link renderStationaryPreviews}. */
  requestPreviewReadback(callback: (data: Uint8ClampedArray<ArrayBuffer>) => void): boolean;
  requestCollisionStats(callback: (stats: CollisionStats) => void): boolean;
  getRenderTiming(): RenderTiming;
  exportTracerView(options: ExportTracerOptions): Promise<ExportTracerResult | null>;
  /** Render one offline frame and return RGBA8 pixels (does not present to canvas). */
  exportFrame(state: RendererState, options: ExportFrameOptions): Promise<ExportFrameResult | null>;
  /** Restore internal render targets after an export at a different resolution. */
  restoreRenderSize(width: number, height: number): void;
  destroy(): void;
}

export interface ChromashiftTextureManager {
  fetchImageList(endpoint: string, signal?: AbortSignal): Promise<ImageEntry[]>;
  loadTexture(url: string): Promise<unknown>;
  uploadPixels(cacheKey: string, pixels: Uint8ClampedArray, width: number, height: number): unknown;
  destroy(): void;
  /** Evict cached local-blob textures not in `keepUrls`, freeing GPU memory until reselected. */
  evictExcept(keepUrls: Iterable<string>): void;
}
