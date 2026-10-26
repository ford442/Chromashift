import type { MutableRefObject, RefObject } from 'react';
import type { ImageEntry } from '../../engine/webgpu/TextureManager';
import type { ChromashiftTextureHandle } from '../../engine/types/TextureHandle';
import type { EngineKind } from '../../engine/WasmEngine';
import type { ReactiveModulation } from '../../engine/reactive/types';
import type { ChromashiftState } from '../../state/types';

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
  rendererRef: RefObject<import('../../engine/types/RendererContracts').ChromashiftRenderer | null>;
  textureManagerRef: RefObject<import('../../engine/types/RendererContracts').ChromashiftTextureManager | null>;
  deviceRef: RefObject<GPUDevice | null>;
  webGpuSessionRef: RefObject<import('../../engine/gpu/gpuBootstrap').WebGpuSession | null>;
  maskTextureRef: MutableRefObject<GPUTexture | null>;
  gpuImageAnalysisRef: RefObject<import('../../engine/compute/GpuImageAnalysis').GpuImageAnalysis | null>;
  upscalerRef: RefObject<import('../../engine/upscale/Upscaler').Upscaler | null>;
}

export interface MediaRefs {
  imageListRef: MutableRefObject<ImageEntry[]>;
  currentImageIndexRef: MutableRefObject<number>;
  ownedObjectUrlsRef: MutableRefObject<string[]>;
  loadGenRef: MutableRefObject<number>;
  engineModeRef: MutableRefObject<EngineKind>;
  renderStateRef: MutableRefObject<ChromashiftState>;
  sourceTextureRef: MutableRefObject<ChromashiftTextureHandle | null>;
  liveSourceManagerRef: MutableRefObject<import('../../engine/live/LiveSource').LiveSourceManager | null>;
}

export interface CompareRefs {
  /** Compare slot B (dual layout): canvas, renderer, independent angle clock. */
  canvasBRef: RefObject<HTMLCanvasElement | null>;
  rendererBRef: MutableRefObject<import('../../engine/types/RendererContracts').ChromashiftRenderer | null>;
  /** Quad layout: Original (a) and Tracer (c) canvases. */
  canvasARef: RefObject<HTMLCanvasElement | null>;
  canvasCRef: RefObject<HTMLCanvasElement | null>;
  quadRenderersRef: MutableRefObject<Record<'a' | 'b' | 'c', import('../../engine/types/RendererContracts').ChromashiftRenderer | null>>;
  animAnglesRef: MutableRefObject<number[]>;
  animAnglesBRef: MutableRefObject<number[]>;
  lastAngleSyncRef: MutableRefObject<number>;
  lastRenderMetricSyncRef: MutableRefObject<number>;
  /** Set by useQuadStationaryRefresh; invoked when quad GPU slots attach. */
  refreshQuadCellsRef: MutableRefObject<(() => void) | null>;
}

export interface ReactiveRefs {
  /** Per-frame audio modulation; null when reactive input is off or idle. */
  reactiveModRef: MutableRefObject<ReactiveModulation | null>;
}

export interface FrameRefs {
  /** The app's one frame clock (`engine/frame/FrameClock.ts`); never reassigned. */
  frameClockRef: MutableRefObject<import('../../engine/frame/FrameClock').FrameClock>;
}

export type ChromashiftRefs = DomRefs & GpuRefs & MediaRefs & CompareRefs & ReactiveRefs & FrameRefs;
