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
 *   workers), so callers need no guard.
 * - The values still land on `window[key]`, so docs, devtools and any external
 *   tooling that reads them keep working unchanged.
 *
 * Adding a breadcrumb: add the field here (documented), then list it in
 * `DIAGNOSTIC_KEYS` — the build fails until you do.
 */

import type { RenderCountsApi } from '../debug/renderCounts';
import type { CompareLayoutMode } from './compareViews';
import type { GpuComputeDiagnostics } from './compute/chores/support';
import type { MotionFlowStats } from './compute/chores/motionKernel';
import type { GraphPresetName } from './graph/altGraphs';
import type { LiveSourceKind } from './LiveSource';
import type { RendererBackend } from './types/RendererContracts';
import type { WebGpuProbeResult } from './webgpuProbe';

export interface ChromashiftDiagnostics {
  // ── Renderer selection (rendererMode.ts, webgpuProbe.ts) ────────────────────
  /** The backend that started, or `null` after a hard-failed WebGPU boot. */
  rendererType: RendererBackend | null;
  /** Device + swapchain are live on WebGPU. */
  usingWebGPU: boolean;
  /** The explicit WebGL diagnostic backend started (never an automatic fallback). */
  usingWebGL: boolean;
  rendererFallbackReason: string | null;
  /** The WebGPU pre-flight: secure context → `navigator.gpu` → adapter. Stops before `requestDevice`. */
  webgpuProbe: WebGpuProbeResult;
  /** WebGL internal render-target scale (`webgl/WebGLRenderer.ts`). */
  webglInternalScale: number;

  // ── Canvas presentation (gpuBootstrap.ts, WebGPURenderer.ts) ────────────────
  /** Whether `hdr-extended` canvas presentation is available this session. */
  canvasHdrAvailable: boolean;
  /** Why (or why not), for diagnostics and E2E. */
  canvasHdrReason: string;
  /** Set while HDR presents over 8-bit internal targets (see `canvasHdrInternalNote`). */
  canvasHdrNote: string | null;

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
  webgpuProbe: true,
  webglInternalScale: true,
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
};

export const DIAGNOSTIC_KEYS = Object.keys(DIAGNOSTIC_KEY_SET) as readonly DiagnosticKey[];

function target(): Partial<ChromashiftDiagnostics> | null {
  return typeof window === 'undefined' ? null : window;
}

/** Publish one breadcrumb. A no-op without a `window`. */
export function publishDiagnostic<K extends DiagnosticKey>(key: K, value: ChromashiftDiagnostics[K]): void {
  const w = target();
  if (w) w[key] = value;
}

/** Publish several breadcrumbs that describe one decision. A no-op without a `window`. */
export function publishDiagnostics(values: Partial<ChromashiftDiagnostics>): void {
  const w = target();
  if (w) Object.assign(w, values);
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
