/**
 * Every `window.*` breadcrumb Chromashift publishes, declared once.
 *
 * Breadcrumbs are how automation and humans read the engine's decisions after
 * the fact — which renderer started, which chore lane served a job, which
 * graph variant drew the frame. They used to be written through ~40 ad-hoc
 * intersection casts on `window` across a dozen modules, so a renamed key
 * broke the E2E specs that read it at runtime instead of at `tsc`. Now:
 *
 * - `ChromashiftDiagnostics` is the one schema. The `Window` augmentation
 *   below is derived from it, so `window.motionFieldBackend` type-checks in
 *   the app *and* in `e2e/` (which `tsconfig.e2e.json` type-checks against
 *   this file).
 * - Writers go through `publishDiagnostic(key, value)` /
 *   `publishDiagnostics({ … })`, which are no-ops without a `window` (Node,
 *   a worker that forwards nothing), so callers need no guard.
 * - A worker whose engine code publishes breadcrumbs the page must show (the
 *   render worker) installs a sink with `forwardDiagnostics`: values are then
 *   kept in a realm-local mirror (so `readDiagnostic` still answers there)
 *   and batched to the sink once per task; the page applies them with
 *   `applyForwardedDiagnostics`. A spec reads the same `window` key whichever
 *   realm published it.
 * - The values still land on `window[key]`, so docs, devtools and any external
 *   tooling that reads them keep working unchanged.
 *
 * Adding a breadcrumb: add the field here (documented), then list it in
 * `DIAGNOSTIC_KEYS` — the build fails until you do.
 */

import type { RenderCountsApi } from '../debug/renderCounts';
import type { RenderDebugApi, RenderTransportKind } from './render/protocol';
import type { CompareLayoutMode } from './compareViews';
import type { GpuComputeDiagnostics } from './compute/chores/support';
import type { WebGLInternalFormat } from './gpu/gpuOptions';
import type { MotionFlowStats } from './compute/chores/motionKernel';
import type { GraphPresetName } from './graph/altGraphs';
import type { LiveSourceKind } from './live/LiveSource';
import type { RendererBackend } from './types/RendererContracts';
import type { WebGpuProbeResult } from './webgpu/webgpuProbe';
import type { WasmEngineState, WasmEngineStatus } from './wasm/loadEngine';

export interface ChromashiftDiagnostics {
  // ── Renderer selection (rendererMode.ts, webgpuProbe.ts) ────────────────────
  /** The backend that started, or `null` after a hard-failed WebGPU boot. */
  rendererType: RendererBackend | null;
  /** Device + swapchain are live on WebGPU. */
  usingWebGPU: boolean;
  /** The explicit WebGL diagnostic backend started (never an automatic fallback). */
  usingWebGL: boolean;
  rendererFallbackReason: string | null;
  /**
   * Where the renderer runs (#253): `worker` — an `OffscreenCanvas` render
   * worker with its own frame clock — or `main`, the page's thread. Published
   * once the transport is chosen, before the device boots.
   */
  renderTransport: RenderTransportKind;
  /** Why that transport: the capability probe's verdict, `?renderer=main`, or the WebGL backend. */
  renderTransportReason: string;
  /** `GPUDevice`s the page's device gate acquired so far, in whichever realm holds it (`adapter.ts`). */
  gpuDevicesAcquired: number;
  /** The WebGPU pre-flight: secure context → `navigator.gpu` → adapter. Stops before `requestDevice`. */
  webgpuProbe: WebGpuProbeResult;
  /** WebGL internal render-target scale (`webgl/WebGLRenderer.ts`). */
  webglInternalScale: number;
  /** The WebGL pool's layer/tracer format: `rgba16f` when the context renders it (`selectWebGLInternalFormat`). */
  webglInternalFormat: WebGLInternalFormat;
  /** Set while the WebGL pool is 8-bit, so tracers clip (see `webglInternalFormatNote`). */
  webglInternalFormatNote: string | null;

  // ── Canvas presentation (canvasConfig.ts, WebGPURenderer.ts) ────────────────
  /** Whether `hdr-extended` canvas presentation is available this session. */
  canvasHdrAvailable: boolean;
  /** Why (or why not), for diagnostics and E2E. */
  canvasHdrReason: string;
  /** Set while HDR presents over 8-bit internal targets (see `canvasHdrInternalNote`). */
  canvasHdrNote: string | null;
  /** The presentation space actually applied (`color/presentation.ts`): what the canvas is converted for and tagged. */
  presentationColorSpace: 'srgb' | 'display-p3';
  /** One line on how Display P3 was (or was not) applied — e.g. WebGL converting in its blit. */
  presentationNote: string | null;
  /** What the last image upload's decoder reported about its colour space, and what was done (`planImageUpload`). */
  imageColorSpace: string;

  // ── GPU timing (GpuTimestampProfiler.ts) ────────────────────────────────────
  gpuTimestampAvailable: boolean;
  gpuTimestampReason: string;

  // ── gpu-chores (compute/chores/support.ts) ──────────────────────────────────
  gpuComputeAvailable: boolean;
  gpuComputeReason: string | null;
  /** Adapter vendor/architecture/device, features and compute limits — Chrome-vs-Edge diagnosis. */
  gpuComputeDiagnostics: GpuComputeDiagnostics | null;
  /**
   * Lane that served the last load-time analysis. CPU lanes are reported as
   * `wasm-worker` / `ts-worker` / `wasm-inline` / `ts-inline`.
   */
  gpuChoreBackend: string | null;
  /** Why every other lane declined. */
  gpuChoreReason: string | null;
  /** Same pair for `motion-field`, which runs on the render loop's cadence. */
  motionFieldBackend: string | null;
  motionFieldReason: string | null;
  /** The last field carried a solved flow vector (Stage 2), not only a magnitude. */
  motionFieldHasFlow: boolean;
  /** Mean velocity over moving cells — CPU lanes only; the WebGPU field never leaves the GPU. */
  motionFieldFlow: MotionFlowStats | null;
  /** Mean magnitude of the last field, in [0,1]. */
  motionFieldEnergy: number;

  // ── C++ WASM engine (wasm/loadEngine.ts) — see docs/wasm-engine.md ─────────
  /** The main thread's engine: set once `loadWasmEngine()` settles. */
  wasmEngineState: WasmEngineState;
  /** Why it is `unavailable` or `error`; `null` once it is `ready`. */
  wasmEngineError: string | null;
  /**
   * Each worker's own engine instance, as its last reply reported it. A
   * worker loads its engine on its first job with Engine mode = WASM, so a
   * worker is absent until then.
   */
  wasmEngineWorkers: Partial<Record<'analysis' | 'motion', WasmEngineStatus>>;

  // ── Textures (textureCacheBreadcrumbs.ts) ───────────────────────────────────
  textureCacheSize: number;
  textureCacheBytes: number;

  // ── Compare / live source / kiosk / XR ──────────────────────────────────────
  compareLayout: CompareLayoutMode;
  compareSwipePosition: number;
  liveSourceActive: boolean;
  liveSourceKind: LiveSourceKind | null;
  liveSourceFps: number;
  kioskMode: boolean;
  /** `immersive-vr` is supported. */
  xrAvailable: boolean;
  xrImmersiveReason: string | null;
  /** An immersive session is running. */
  xrImmersive: boolean;

  // ── Pass graph (graph/gate.ts) — see docs/PASS_GRAPH.md ────────────────────
  /** True when the pass-graph compiler ran for this session. */
  passGraphActive: boolean;
  /** Compilations so far — must not move when a parameter changes. */
  passGraphCompileCount: number;
  /** Scheduled pass order, for E2E assertions. */
  passGraphPasses: string[];
  /** Pool slot count per resolution class. */
  passGraphSlots: Record<string, number>;
  /**
   * `history` ring textures per resolution class — VRAM that outlives the
   * frame and so is not in `passGraphSlots`. Empty when no graph compiled.
   */
  passGraphRingFrames: Record<string, number>;
  /** Set when compilation refused the graph, naming the node. */
  passGraphError: string | null;
  /** Which named graph shape the gate selected. */
  passGraphName: GraphPresetName | null;
  /**
   * The variant of that shape a renderer last compiled for a frame
   * (`graphVariantKey`: layer count, temporal term, presentation), or `null`
   * when no renderer builds variants (the gate alone, the WebGL backend).
   */
  passGraphVariant: string | null;
  /**
   * Name of the graph shape the primary canvas's executor drew last frame —
   * the selected one, or `default` standing in for a variant it refused —
   * or `null` for a frame nothing validated could draw.
   */
  passGraphExecuting: GraphPresetName | null;
  /**
   * The variant (`graphVariantKey`) that frame drew. It trails
   * `passGraphVariant` while the device validates a new variant, since the
   * last one keeps drawing until then.
   */
  passGraphDrawnVariant: string | null;
  /**
   * Node ids the executor actually encodes, in order. Shorter than
   * `passGraphPasses`: `source` and `output` own no pass, and a `coincidence`
   * fused into its `decay` consumers is absorbed by them.
   */
  passGraphExecutedPasses: string[];
  /**
   * Per orchestrator slot (`main`, `compare-b`, the quad cells): the graph
   * shape that slot's executor drew last frame, or `null` while nothing
   * validated could draw it. Absent for a slot that has no renderer.
   */
  passGraphSlotsExecuting: Record<string, GraphPresetName | null>;

  // ── Debug APIs ──────────────────────────────────────────────────────────────
  /** Render tallies, armed by `?debugRenders=1` (`src/debug/renderCounts.ts`). */
  __renderCounts: RenderCountsApi;
  /**
   * Renderer hooks for automation, on either transport — the presented frame,
   * a simulated device loss, the render clock's tick times. Armed by
   * `?renderDebug=1` (or `localStorage['chromashift:renderDebug'] = '1'`); see
   * `engine/render/debug.ts`.
   */
  __renderDebug: RenderDebugApi;
}

export type DiagnosticKey = keyof ChromashiftDiagnostics;

declare global {
  // Derived, not restated: every breadcrumb is an optional property of `window`.
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  interface Window extends Partial<ChromashiftDiagnostics> {}
}

/** Every key, at runtime. A `Record` so a field missing here fails the build. */
const DIAGNOSTIC_KEY_SET: Record<DiagnosticKey, true> = {
  rendererType: true,
  usingWebGPU: true,
  usingWebGL: true,
  rendererFallbackReason: true,
  renderTransport: true,
  renderTransportReason: true,
  gpuDevicesAcquired: true,
  webgpuProbe: true,
  webglInternalScale: true,
  webglInternalFormat: true,
  webglInternalFormatNote: true,
  presentationColorSpace: true,
  presentationNote: true,
  imageColorSpace: true,
  canvasHdrAvailable: true,
  canvasHdrReason: true,
  canvasHdrNote: true,
  gpuTimestampAvailable: true,
  gpuTimestampReason: true,
  gpuComputeAvailable: true,
  gpuComputeReason: true,
  gpuComputeDiagnostics: true,
  gpuChoreBackend: true,
  gpuChoreReason: true,
  motionFieldBackend: true,
  motionFieldReason: true,
  motionFieldHasFlow: true,
  motionFieldFlow: true,
  motionFieldEnergy: true,
  wasmEngineState: true,
  wasmEngineError: true,
  wasmEngineWorkers: true,
  textureCacheSize: true,
  textureCacheBytes: true,
  compareLayout: true,
  compareSwipePosition: true,
  liveSourceActive: true,
  liveSourceKind: true,
  liveSourceFps: true,
  kioskMode: true,
  xrAvailable: true,
  xrImmersiveReason: true,
  xrImmersive: true,
  passGraphActive: true,
  passGraphCompileCount: true,
  passGraphPasses: true,
  passGraphSlots: true,
  passGraphRingFrames: true,
  passGraphError: true,
  passGraphName: true,
  passGraphVariant: true,
  passGraphExecuting: true,
  passGraphDrawnVariant: true,
  passGraphExecutedPasses: true,
  passGraphSlotsExecuting: true,
  __renderCounts: true,
  __renderDebug: true,
};

export const DIAGNOSTIC_KEYS = Object.keys(DIAGNOSTIC_KEY_SET) as readonly DiagnosticKey[];

/** Where a worker's breadcrumbs go (the render worker posts them to the page). */
export type DiagnosticsSink = (values: Partial<ChromashiftDiagnostics>) => void;

interface Forwarding {
  sink: DiagnosticsSink;
  /** This realm's breadcrumbs, so `readDiagnostic` answers in a worker too. */
  mirror: Partial<ChromashiftDiagnostics>;
  /** Published since the last flush. */
  batch: Partial<ChromashiftDiagnostics> | null;
  /** Last value forwarded per key, for primitives only. */
  sent: Map<DiagnosticKey, unknown>;
}

let forwarding: Forwarding | null = null;

function target(): Partial<ChromashiftDiagnostics> | null {
  if (typeof window !== 'undefined') return window;
  return forwarding?.mirror ?? null;
}

function isPrimitive(value: unknown): boolean {
  return value === null || (typeof value !== 'object' && typeof value !== 'function');
}

/**
 * Queue `values` for the sink. One message per task however many breadcrumbs
 * the task published, and a primitive that did not change since it was last
 * forwarded is not sent again — the render loop republishes a few per frame,
 * and the page should not wake for an unchanged boolean sixty times a second.
 */
function forward(values: Partial<ChromashiftDiagnostics>): void {
  const state = forwarding;
  if (!state) return;
  const changed: Partial<Record<DiagnosticKey, unknown>> = {};
  let any = false;
  for (const [key, value] of Object.entries(values) as [DiagnosticKey, unknown][]) {
    if (isPrimitive(value) && state.sent.has(key) && Object.is(state.sent.get(key), value)) continue;
    if (isPrimitive(value)) state.sent.set(key, value);
    else state.sent.delete(key);
    changed[key] = value;
    any = true;
  }
  if (!any) return;
  if (state.batch === null) {
    state.batch = {};
    queueMicrotask(() => {
      const batch = state.batch;
      state.batch = null;
      if (batch && forwarding === state) state.sink(batch);
    });
  }
  Object.assign(state.batch, changed);
}

/**
 * Keep this realm's breadcrumbs in a local mirror and hand every change to
 * `sink` (a worker that has no `window`); `null` stops forwarding. Ignored on
 * a page, whose breadcrumbs are `window`'s own.
 */
export function forwardDiagnostics(sink: DiagnosticsSink | null): void {
  if (typeof window !== 'undefined') return;
  forwarding = sink ? { sink, mirror: {}, batch: null, sent: new Map() } : null;
}

/**
 * Forward the next value of every key even if it matches what was last sent.
 * The render service calls it at each boot: a page (or a spec) may have
 * cleared a breadcrumb on its `window` since, and the boot republishes them.
 */
export function resendForwardedDiagnostics(): void {
  forwarding?.sent.clear();
}

/**
 * Page side of `forwardDiagnostics`: publish what a worker forwarded.
 * `wasmEngineWorkers` merges, since the page and each worker report their
 * own entries into one record.
 */
export function applyForwardedDiagnostics(values: Partial<ChromashiftDiagnostics>): void {
  const w = target();
  if (!w) return;
  const { wasmEngineWorkers, ...rest } = values;
  Object.assign(w, rest);
  if (wasmEngineWorkers) w.wasmEngineWorkers = { ...w.wasmEngineWorkers, ...wasmEngineWorkers };
}

/** Publish one breadcrumb. A no-op without a `window` or a forwarding sink. */
export function publishDiagnostic<K extends DiagnosticKey>(key: K, value: ChromashiftDiagnostics[K]): void {
  const w = target();
  if (w) w[key] = value;
  if (forwarding) forward({ [key]: value });
}

/** Publish several breadcrumbs that describe one decision. A no-op without a `window` or a forwarding sink. */
export function publishDiagnostics(values: Partial<ChromashiftDiagnostics>): void {
  const w = target();
  if (w) Object.assign(w, values);
  if (forwarding) forward(values);
}

/** Record one worker's engine status in `wasmEngineWorkers`. */
export function publishWorkerWasmEngine(worker: 'analysis' | 'motion', status: WasmEngineStatus): void {
  const w = target();
  if (!w) return;
  w.wasmEngineWorkers = { ...w.wasmEngineWorkers, [worker]: status };
  if (forwarding) forward({ wasmEngineWorkers: { [worker]: status } });
}

/** Read one breadcrumb; `undefined` until something has published it. */
export function readDiagnostic<K extends DiagnosticKey>(key: K): ChromashiftDiagnostics[K] | undefined {
  return target()?.[key];
}

/** A snapshot of every breadcrumb published so far. */
export function readDiagnostics(): Partial<ChromashiftDiagnostics> {
  const w = target();
  const snapshot: Partial<Record<DiagnosticKey, unknown>> = {};
  if (!w) return snapshot as Partial<ChromashiftDiagnostics>;
  for (const key of DIAGNOSTIC_KEYS) {
    if (w[key] !== undefined) snapshot[key] = w[key];
  }
  return snapshot as Partial<ChromashiftDiagnostics>;
}

/** Forget every breadcrumb, so one test cannot observe another's. */
export function resetDiagnosticsForTests(): void {
  const w = target();
  if (!w) return;
  for (const key of DIAGNOSTIC_KEYS) delete w[key];
}
