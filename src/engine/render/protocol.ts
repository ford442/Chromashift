/**
 * The render protocol (#253): everything the page asks of the renderer, and
 * everything the renderer tells the page, as one typed surface.
 *
 * `RenderService` implements it once. Two transports carry it:
 *
 * - **worker** — `render.worker.ts` hosts the service behind the shared worker
 *   channel (`workers/rpc.ts`). Canvases arrive as transferred
 *   `OffscreenCanvas`es; the service's `FrameClock` ticks on the worker's own
 *   `requestAnimationFrame`, so a busy page does not drop frames.
 * - **main** — the service runs in-process on the page's `FrameClock`, exactly
 *   as the renderer always has. The WebGL backend (and so WebXR) always takes
 *   this one, and `?renderer=main` forces it for WebGPU.
 *
 * The page never holds a renderer, a device or a texture: it posts state and
 * asks for pixels. See `RenderHost` for its side and docs/gpu-bootstrap.md
 * § *Render transport*.
 */

import type { ChromashiftDiagnostics } from '../diagnostics';
import type { CompareLayoutMode } from '../compareViews';
import type { DisplayColorSpace } from '../gpu/gpuOptions';
import type { GpuRuntimeError } from '../gpu/gpuErrors';
import type { MotionFieldUse } from '../graph/exec/plan';
import type { GraphPresetName } from '../graph/altGraphs';
import type { RenderWorkerScopeReport } from '../graph/capabilities';
import type { LiveFrameSource } from '../live/liveSourceTexture';
import type { ReactiveModulation } from '../reactive/types';
import type { StationaryPreviewOptions, StationaryPreviewResult } from '../stationaryPreview';
import type {
  CpuMotionField,
  ExportFrameOptions,
  ExportFrameResult,
  ExportTracerOptions,
  ExportTracerResult,
  GpuRenderTiming,
  RendererBackend,
} from '../types/RendererContracts';
import type { CollisionStats, RendererState } from '../types/RendererState';

/** Where the renderer runs. */
export type RenderTransportKind = 'worker' | 'main';

/** A canvas the service draws: the page's element (main) or its transferred `OffscreenCanvas` (worker). */
export type RenderCanvas = HTMLCanvasElement | OffscreenCanvas;

/**
 * One page canvas, by the id `RenderHost` gave it. `canvas` rides along the
 * first time the service sees that id — transferred, on the worker — and is
 * omitted afterwards: a canvas can be transferred once, so a re-attach (a
 * React effect re-run, Retry GPU) names the one the service already holds.
 */
export interface RenderSurface {
  canvasId: number;
  canvas?: RenderCanvas;
  /** Backing-store size in device pixels. */
  width: number;
  height: number;
}

export interface RenderBootRequest {
  surface: RenderSurface;
  backend: RendererBackend;
  antialias: boolean;
  colorSpace: DisplayColorSpace;
  canvasHdr: boolean;
  /** The graph shape the page's gate selected (`?graph=`, or the stored preference). */
  passGraph: GraphPresetName;
  /** The page's `location.search`, for flags engine code reads (`?no_gpu_compute`). */
  pageSearch: string;
  /** Retry GPU: release the page's device and adapter before booting. */
  retry: boolean;
  /** `__renderDebug` is armed: canvases also get `COPY_SRC`, for the presented-frame readback. */
  debug: boolean;
}

export type RenderBootResult =
  | { ok: true; backend: RendererBackend; fallbackReason: string | null }
  /** The overlay's error: a probe failure, a device that would not boot, the fatal breaker. */
  | { ok: false; error: GpuRuntimeError }
  /** A later `boot` or `shutdown` overtook this one; nothing was kept. */
  | { ok: false; cancelled: true };

/** Compare slot B (dual / swipe): its own settings, and its own angle clock unless synced. */
export interface RenderLoopCompare {
  state: RendererState;
  extensions: number[];
  fps: number;
  syncPlay: boolean;
}

/**
 * What the live loop draws, posted whenever the store changes. The service
 * keeps the latest; each tick it advances the angles and writes them in.
 */
export interface RenderLoopInput {
  /** Draw frames: the GPU is ready and no video export holds the renderer. */
  running: boolean;
  fps: number;
  /** The layers' spin rates, used unless a reactive modulation overrides them. */
  extensions: number[];
  /** Reactive input is on: the latest `set-modulation` drives extensions and three uniforms. */
  reactive: boolean;
  /** The main canvas's frame, angles aside — `buildRendererState` of the store. */
  main: RendererState;
  layout: CompareLayoutMode;
  compareB: RenderLoopCompare | null;
  hud: { enabled: boolean; autoDegrade: boolean };
}

/** The CPU motion-field lane's inputs, as the renderer currently wants them. */
export interface MotionDemand {
  /** `setMotionField` input is wanted (WebGL always; WebGPU only when its GPU lane declined). */
  wantsCpu: boolean;
  use: MotionFieldUse;
}

/** Telemetry the loop publishes for the HUD and the knobs — never into the store. */
export interface RenderTelemetry {
  angles?: number[];
  cpu?: { last: number; avg: number };
  gpu?: GpuRenderTiming;
  frameHistory?: number[];
  overBudget?: boolean;
}

/** One frame read out of a canvas's presentation texture (`__renderDebug.readPresentedFrame`). */
export interface PresentedFrame {
  width: number;
  height: number;
  /** The texture's own format: rows of `bytesPerRow`, 4 bytes (8 for `rgba16float`) a texel. */
  format: GPUTextureFormat;
  bytesPerRow: number;
  bytes: ArrayBuffer;
}

export interface LoadSourceRequest {
  url: string;
  /** URLs to keep resident; everything else may be evicted. */
  keep: string[];
  /** Also return a downscaled bitmap of the source, for the Original thumbnail. */
  preview?: { width: number; height: number };
}

export interface LoadSourceResult {
  width: number;
  height: number;
  preview: ImageBitmap | null;
}

export interface AnalyzeSourceRequest {
  url: string;
  /** Engine mode = WASM, and the page's engine loaded: the CPU lanes may use it. */
  useWasm: boolean;
}

export interface ExportFrameRequest {
  state: RendererState;
  options: ExportFrameOptions;
  /** Draw at the live angles (the still export), not the ones in `state`. */
  liveAngles?: boolean;
}

/** One quad stationary cell: a slot drawn once with its own state. */
export interface RenderCellRequest {
  slot: string;
  state: RendererState;
  fps: number;
  /** Clear and run the tracer warm-up before drawing (the Tracer cell). */
  warmup?: RendererState;
}

/** Method → `(request) => response`. `notify` methods return `void` and are never answered. */
export type RenderProtocol = {
  boot: (req: RenderBootRequest) => RenderBootResult;
  /** Tear the renderer down (a React cleanup). The device lease and the canvases stay. */
  shutdown: (req: Record<string, never>) => void;
  attach: (req: { slot: string; surface: RenderSurface }) => void;
  detach: (req: { slot: string }) => void;
  /** notify: canvas backing sizes changed; reconfigure before the next frame. */
  resize: (req: { surfaces: { canvasId: number; width: number; height: number }[] }) => void;
  /** notify: the page dropped this canvas for good. */
  'release-canvas': (req: { canvasId: number }) => void;

  /** notify: the latest loop input (coalesced). */
  'set-loop': (req: RenderLoopInput) => void;
  /** notify: this frame's reactive modulation. */
  'set-modulation': (req: { modulation: ReactiveModulation | null }) => void;
  /** notify: reset the live angles (a knob drag, a preset load). */
  'set-angles': (req: { angles: number[] }) => void;
  'get-angles': (req: Record<string, never>) => number[];

  /** notify */
  'set-antialiasing': (req: { enabled: boolean }) => void;
  /** notify */
  'set-canvas': (req: { colorSpace?: DisplayColorSpace; canvasHdr?: boolean }) => void;
  /** notify: clear the tracers of the main slot and the named others. */
  'clear-persistence': (req: { slots?: string[] }) => void;

  'load-source': (req: LoadSourceRequest) => LoadSourceResult;
  /** Upload RGBA8 pixels (the upscaler's output) as the source. */
  'upload-pixels': (req: { key: string; pixels: Uint8ClampedArray<ArrayBuffer>; width: number; height: number }) => void;
  /**
   * notify: the live source's current frame, uploaded on arrival — the
   * element itself in-process; a transferred `VideoFrame` / `ImageBitmap` to
   * the worker, which the service closes.
   */
  'set-video-frame': (req: { frame: LiveFrameSource }) => void;
  /** notify: the live source stopped. */
  'release-video': (req: Record<string, never>) => void;
  /** Classification mask + average luminance for the current source. */
  'analyze-source': (req: AnalyzeSourceRequest) => { avgLuminance: number };
  /** notify */
  'clear-mask': (req: Record<string, never>) => void;
  /** notify: a CPU-lane motion field (transferred). */
  'set-motion-field': (req: { motion: CpuMotionField | null }) => void;

  'stationary-previews': (req: { state: RendererState; options: StationaryPreviewOptions }) => StationaryPreviewResult;
  'render-cells': (req: { cells: RenderCellRequest[] }) => void;
  'collision-stats': (req: Record<string, never>) => CollisionStats | null;
  'export-tracer': (req: ExportTracerOptions) => ExportTracerResult | null;
  'export-frame': (req: ExportFrameRequest) => ExportFrameResult | null;
  /** A video export starts: clear the tracers; on the worker, take its clock offline. */
  'export-begin': (req: Record<string, never>) => void;
  /** …and ends: restore the canvas-sized targets and the realtime clock. */
  'export-end': (req: { width: number; height: number }) => void;

  'debug-presented-frame': (req: { slot: string }) => PresentedFrame;
  'debug-lose-device': (req: Record<string, never>) => void;
  'debug-frame-timeline': (req: Record<string, never>) => number[];
};

/**
 * What `render.worker.ts` answers beyond the protocol: the worker half of the
 * `render-worker` capability, asked before the first boot (`transport.ts`).
 */
export type RenderWorkerProtocol = RenderProtocol & {
  probe: (req: Record<string, never>) => RenderWorkerScopeReport;
};

/** What the service reports unasked. */
export type RenderEvents = {
  /** Breadcrumbs published in the service's realm, for the page's `window`. */
  diagnostics: Partial<ChromashiftDiagnostics>;
  /** A refused pipeline, a lost device or context: the overlay's input. */
  'runtime-error': GpuRuntimeError;
  /** WebGL: the browser restored a lost context; boot again on it. */
  'context-restored': Record<string, never>;
  telemetry: RenderTelemetry;
  /** The Perf HUD's auto-degrade fired: the page lowers its scales. */
  'perf-degrade': Record<string, never>;
  'motion-demand': MotionDemand;
};

export type RenderEmit = <K extends keyof RenderEvents & string>(
  event: K,
  payload: RenderEvents[K],
  transfer?: Transferable[],
) => void;

/** `window.__renderDebug` — see `engine/render/debug.ts`. */
export interface RenderDebugApi {
  /** The transport the hooks below reach. */
  transport: RenderTransportKind;
  /** The next frame `slot` presents (default `main`), read from its canvas texture. */
  readPresentedFrame(slot?: string): Promise<PresentedFrame>;
  /** Destroy the device as a driver reset would (`lost` reason `unknown`). */
  loseDevice(): Promise<void>;
  /** The render clock's recent tick times, as epoch ms (`performance.timeOrigin + now`). */
  frameTimeline(): Promise<number[]>;
}
