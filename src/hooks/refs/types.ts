import type { MutableRefObject, RefObject } from 'react';
import type { ImageEntry } from '../../engine/library/imageEntry';
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
  /**
   * The page's handle on the renderer (`engine/render/RenderHost.ts`), on
   * whichever thread it runs (#253). The page holds no renderer, device or
   * texture: it posts state and asks for pixels. Never reassigned.
   */
  renderHostRef: RefObject<import('../../engine/render/RenderHost').RenderHost>;
  upscalerRef: RefObject<import('../../engine/upscale/Upscaler').Upscaler | null>;
}

export interface MediaRefs {
  imageListRef: MutableRefObject<ImageEntry[]>;
  currentImageIndexRef: MutableRefObject<number>;
  ownedObjectUrlsRef: MutableRefObject<string[]>;
  loadGenRef: MutableRefObject<number>;
  engineModeRef: MutableRefObject<EngineKind>;
  renderStateRef: MutableRefObject<ChromashiftState>;
  liveSourceManagerRef: MutableRefObject<import('../../engine/live/LiveSource').LiveSourceManager | null>;
}

export interface CompareRefs {
  /** Compare slot B (dual / swipe layouts). Its renderer and angle clock live in the render service. */
  canvasBRef: RefObject<HTMLCanvasElement | null>;
  /** Quad layout: Original (a) and Tracer (c) canvases. */
  canvasARef: RefObject<HTMLCanvasElement | null>;
  canvasCRef: RefObject<HTMLCanvasElement | null>;
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
