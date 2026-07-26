import type { MutableRefObject, RefObject } from 'react';
import type { ImageEntry } from '../../engine/TextureManager';
import type { ChromashiftTextureHandle } from '../../engine/types/TextureHandle';
import type { EngineKind } from '../../engine/WasmEngine';
import type { ReactiveModulation } from '../../engine/reactive/types';
import type { ChromashiftState, LayerTriple } from '../../state/types';

export interface DomRefs {
  containerRef: RefObject<HTMLDivElement | null>;
  mainViewportRef: RefObject<HTMLDivElement | null>;
  mainCanvasRef: RefObject<HTMLCanvasElement | null>;
  previewOriginalRef: RefObject<HTMLCanvasElement | null>;
  previewSeparatedRef: RefObject<HTMLCanvasElement | null>;
  overlaySeparatedRef: RefObject<HTMLCanvasElement | null>;
  previewTracerRef: RefObject<HTMLCanvasElement | null>;
  tracerScratchRef: RefObject<HTMLCanvasElement | null>;
  tracerDragRef: MutableRefObject<{ pointerId: number; x: number; y: number } | null>;
  capturePreviewAfterRender: MutableRefObject<boolean>;
}

export interface GpuRefs {
  orchestratorRef: RefObject<import('../../engine/RendererOrchestrator').RendererOrchestrator | null>;
  rendererRef: RefObject<import('../../engine/RendererTypes').ChromashiftRenderer | null>;
  textureManagerRef: RefObject<import('../../engine/RendererTypes').ChromashiftTextureManager | null>;
  deviceRef: RefObject<GPUDevice | null>;
  webGpuSessionRef: RefObject<import('../../engine/gpuBootstrap').WebGpuSession | null>;
  maskTextureRef: MutableRefObject<GPUTexture | null>;
  gpuImageAnalysisRef: RefObject<import('../../engine/compute/GpuImageAnalysis').GpuImageAnalysis | null>;
  upscalerRef: RefObject<import('../../engine/Upscaler').Upscaler | null>;
}

export interface MediaRefs {
  imageListRef: MutableRefObject<ImageEntry[]>;
  currentImageIndexRef: MutableRefObject<number>;
  ownedObjectUrlsRef: MutableRefObject<string[]>;
  loadGenRef: MutableRefObject<number>;
  engineModeRef: MutableRefObject<EngineKind>;
  renderStateRef: MutableRefObject<ChromashiftState>;
  sourceTextureRef: MutableRefObject<ChromashiftTextureHandle | null>;
}

export interface CompareRefs {
  /** Compare slot B (dual layout): canvas, renderer, independent angle clock. */
  canvasBRef: RefObject<HTMLCanvasElement | null>;
  rendererBRef: MutableRefObject<import('../../engine/RendererTypes').ChromashiftRenderer | null>;
  /** Quad layout: Original (a) and Tracer (c) canvases. */
  canvasARef: RefObject<HTMLCanvasElement | null>;
  canvasCRef: RefObject<HTMLCanvasElement | null>;
  quadRenderersRef: MutableRefObject<Record<'a' | 'b' | 'c', import('../../engine/RendererTypes').ChromashiftRenderer | null>>;
  animAnglesRef: MutableRefObject<LayerTriple<number>>;
  animAnglesBRef: MutableRefObject<LayerTriple<number>>;
  lastAngleSyncRef: MutableRefObject<number>;
  lastRenderMetricSyncRef: MutableRefObject<number>;
  /** Set by useQuadStationaryRefresh; invoked when quad GPU slots attach. */
  refreshQuadCellsRef: MutableRefObject<(() => void) | null>;
}

export interface ReactiveRefs {
  /** Per-frame audio modulation; null when reactive input is off or idle. */
  reactiveModRef: MutableRefObject<ReactiveModulation | null>;
}

export type ChromashiftRefs = DomRefs & GpuRefs & MediaRefs & CompareRefs & ReactiveRefs;
