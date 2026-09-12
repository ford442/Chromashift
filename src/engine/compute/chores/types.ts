/**
 * `gpu-chores` — shared kit API shapes.
 *
 * These types are the module boundary other apps in the rollout
 * (`clip_stacker`, `image_video_effects`, `flac_player`, `mod-player`,
 * `web_sequencer`) depend on. Chromashift is the reference consumer: the
 * shapes here must stay app-agnostic even though the only implementation
 * today lives in-tree.
 *
 * Nothing in this file may import Chromashift-specific modules.
 */

import type { MotionFieldStats } from './motionKernel';

export type { MotionFieldStats } from './motionKernel';

/** Concrete execution lanes, in the order the facade prefers them. */
export type ChoreBackend = 'webgpu' | 'wasm' | 'ts';

/**
 * Caller-facing lane selection.
 * - `auto`   — walk the preference order, first lane that accepts the job wins.
 * - `webgpu` / `wasm` / `ts` — pin a single lane; the facade declines rather
 *   than silently sliding to another lane, which keeps parity tests honest.
 */
export type ChorePreference = 'auto' | ChoreBackend;

/**
 * Canonical fallback order. WebGL2 is deliberately absent: atomics/histogram
 * have no workable GL2 story, and running a compute device *and* a GL context
 * for one analysis is the failure mode this kit exists to prevent.
 */
export const CHORE_BACKEND_ORDER: readonly ChoreBackend[] = ['webgpu', 'wasm', 'ts'];

/** Operations the kit knows how to dispatch. */
export type ChoreOp = 'image-analysis' | 'coincidence' | 'motion-field';

/**
 * Analyze an image: 256-bin BT.709 luminance histogram + per-pixel band mask.
 *
 * A job may carry a GPU texture, a decoded CPU image, or both. Lanes advertise
 * which inputs they can consume, so a caller that only has an `HTMLImageElement`
 * transparently lands on `wasm`/`ts` without the GPU lane ever being asked.
 */
export interface ImageAnalysisJob {
  op: 'image-analysis';
  /** GPU-resident source. Required by the `webgpu` lane. */
  source?: GPUTexture | null;
  /** CPU-decodable source. Required by the `wasm` and `ts` lanes. */
  image?: HTMLImageElement | null;
  width: number;
  height: number;
  /**
   * Skips the histogram readback when the caller already knows the average.
   * The GPU lane still runs the histogram pass (the mask needs the texture
   * bound anyway); this only overrides the derived scalar.
   */
  avgLumHint?: number;
  prefer?: ChorePreference;
}

/**
 * Detect tracer layer overlaps ("coincidence"): 2+ layers with visible
 * colour at a pixel. GPU-only — there is no load-time analogue, so the
 * `wasm`/`ts` lanes always decline this op rather than pretending to have a
 * CPU implementation.
 */
export interface CoincidenceJob {
  op: 'coincidence';
  /** Three GPU-resident layer textures, all the same size. Required. */
  layers?: readonly [GPUTexture, GPUTexture, GPUTexture] | null;
  width: number;
  height: number;
  /** Minimum alpha to consider a layer "visible" at a pixel. */
  colorThresh: number;
  /** Brightness multiplier applied only to a fresh collision stamp. */
  stampBoost: number;
  /** 0 = combined colour, 1 = grey highlight. */
  tracerMode: number;
  prefer?: ChorePreference;
}

/**
 * Produce a low-resolution motion field for the current source frame.
 *
 * The lane owns the previous frame's luminance, so a caller only ever hands
 * over the *current* frame: on a per-frame render loop that is the difference
 * between one texture upload and an extra full-resolution history copy.
 *
 * Both lane families are real here, unlike `coincidence`: the `webgpu` lane
 * consumes a GPU-resident frame and keeps the field on the GPU, while the
 * `wasm`/`ts` lanes consume decoded pixels and return a small array — which is
 * what keeps the WebGL diagnostic backend and headless CI honest.
 */
export interface MotionFieldJob {
  op: 'motion-field';
  /** GPU-resident current frame. Required by the `webgpu` lane. */
  source?: GPUTexture | null;
  /** Decoded current frame, tightly packed RGBA8. Required by the CPU lanes. */
  pixels?: MotionFramePixels | null;
  width: number;
  height: number;
  /** Resolution divisor for the field; defaults to 4 (quarter resolution). */
  divisor?: number;
  /** Noise floor on the normalised luminance difference, in [0,1). */
  threshold: number;
  /**
   * Drop the previous-frame history before differencing (source switch, seek,
   * resize). The resulting field is all-zero, exactly like a first frame.
   */
  reset?: boolean;
  prefer?: ChorePreference;
}

/** Decoded RGBA8 frame handed to the CPU lanes. */
export interface MotionFramePixels {
  data: Uint8ClampedArray | Uint8Array;
  width: number;
  height: number;
}

export type ChoreJob = ImageAnalysisJob | CoincidenceJob | MotionFieldJob;

/**
 * GPU lane output. The mask stays a `GPUTexture` — the CPU contract for this
 * op is a 256-entry histogram readback and nothing more. Never add a
 * full-image readback here.
 */
export interface GpuImageAnalysisOutput {
  kind: 'gpu-texture';
  avgLuminance: number;
  /** Owned and reused by the runtime; callers must not destroy it. */
  maskTexture: GPUTexture;
  histogram: Uint32Array;
}

/**
 * CPU lane output. The mask is a band index per pixel, ready for upload into
 * an `r8uint` texture by the caller (the kit does not own a device on this
 * lane, so it cannot do the upload itself).
 */
export interface CpuImageAnalysisOutput {
  kind: 'cpu-mask';
  avgLuminance: number;
  mask: Uint8Array;
  width: number;
  height: number;
}

export type ImageAnalysisOutput = GpuImageAnalysisOutput | CpuImageAnalysisOutput;

/**
 * Coincidence lane output. Both textures are owned and reused by the
 * runtime; callers must not destroy them.
 */
export interface GpuCoincidenceOutput {
  kind: 'gpu-coincidence';
  /** rgba32float, write-only storage: rgb/a = this frame's collision stamp (zero when none was painted). */
  stampTexture: GPUTexture;
  /** rgba8unorm, write-only storage: same encoding as the legacy fragment-shader diagnostic output. */
  diagTexture: GPUTexture;
}

/**
 * GPU lane output. The field stays a `GPUTexture` — no full readback, ever.
 * Summary statistics are fetched separately and on the caller's own cadence
 * (see `WebGpuChoreBackend.readMotionFieldStats`), so the per-frame path never
 * maps a buffer.
 */
export interface GpuMotionFieldOutput {
  kind: 'gpu-motion-field';
  /**
   * `rgba16float`: r = magnitude in [0,1], gb = flow vector (zero for the
   * frame-difference stage), a = 1. Owned and reused by the lane; callers
   * must not destroy it.
   */
  fieldTexture: GPUTexture;
  width: number;
  height: number;
}

/**
 * CPU lane output. One float per field cell — at the default quarter-scale
 * divisor a 1080p frame is a 480×270 array, which is the "small array" half of
 * the chores CPU contract, not a full-image readback.
 */
export interface CpuMotionFieldOutput {
  kind: 'cpu-motion-field';
  field: Float32Array;
  width: number;
  height: number;
  stats: MotionFieldStats;
}

export type MotionFieldOutput = GpuMotionFieldOutput | CpuMotionFieldOutput;

export type ChoreOutput = ImageAnalysisOutput | GpuCoincidenceOutput | MotionFieldOutput;

/** A lane ran the job. */
export interface ChoreSuccess<T> {
  ok: true;
  backend: ChoreBackend;
  value: T;
}

/**
 * No lane ran the job. `attempts` records why each candidate declined or
 * failed, which is what makes a Chrome-vs-Edge divergence diagnosable instead
 * of surfacing as a blank analysis.
 */
export interface ChoreFailure {
  ok: false;
  backend: null;
  reason: string;
  attempts: readonly ChoreAttempt[];
}

export interface ChoreAttempt {
  backend: ChoreBackend;
  /** `declined` = lane could not take the job; `failed` = lane threw. */
  outcome: 'declined' | 'failed';
  reason: string;
}

export type ChoreResult<T> = ChoreSuccess<T> | ChoreFailure;

/** One execution lane. Registered with the runtime at construction. */
export interface ChoreBackendImpl {
  readonly backend: ChoreBackend;
  /** Cheap, synchronous gate — no device work, no allocation. */
  canRun(job: ChoreJob): boolean;
  /** Why `canRun` returned false, for the attempt log. */
  declineReason(job: ChoreJob): string;
  run(job: ChoreJob): Promise<ChoreOutput | null>;
  /**
   * More specific than `backend` for diagnostics only (`window.gpuChoreBackend`) —
   * e.g. `wasm-worker` vs `wasm-inline`. Falls back to `backend` when absent.
   * Never used for lane-selection logic; `ChoreResult.backend` stays the plain
   * `ChoreBackend` enum so pinned-lane parity tests keep meaning what they say.
   */
  breadcrumbLabel?(): string;
  destroy?(): void;
}

/** Result of the CPU lanes' combined average-luminance + classification-mask work. */
export interface CpuImageAnalysisResult {
  avgLuminance: number;
  mask: Uint8Array;
  width: number;
  height: number;
  /**
   * Which execution mode actually served this call — surfaced only for the
   * `breadcrumbLabel()` diagnostic (e.g. `wasm-worker` vs `wasm-inline`).
   * `worker` = ran off the main thread; `inline` = ran synchronously
   * in-process (the Vitest/parity host, or a worker-host's fallback path).
   */
  mode: 'worker' | 'inline';
}

/**
 * Optional WASM acceleration for the `motion-field` op.
 *
 * A host that cannot supply it simply omits it: the `wasm` lane then declines
 * motion jobs with a recorded reason and `auto` slides to `ts`, which always
 * has the portable kernel. That is the same "decline, never pretend" rule the
 * WASM lane already follows for `image-analysis`.
 */
export interface CpuMotionFieldHost {
  motionField(
    frame: MotionFramePixels,
    divisor: number,
    threshold: number,
    reset: boolean,
  ): Promise<CpuMotionFieldResult | null>;
}

/** Result of a host-supplied WASM motion-field call. */
export interface CpuMotionFieldResult {
  field: Float32Array;
  width: number;
  height: number;
}

/**
 * Host-supplied CPU implementation backing the `wasm` and `ts` lanes. Injected
 * rather than imported so `chores/` stays free of Chromashift-specific
 * dependencies — sibling apps supply their own equivalent.
 *
 * Async so a host can run the (expensive, main-thread-blocking on an 8K
 * source) pixel readback and classification off the main thread — e.g. inside
 * a Web Worker — without changing the lane contract: `ChoresRuntime.runJob`
 * is already `async`.
 */
export interface CpuChoreHost extends Partial<CpuMotionFieldHost> {
  /** True when the WASM module is loaded and callable. */
  isWasmReady(): boolean;
  /**
   * Compute average luminance (unless `avgLumHint` is given) and the
   * classification mask for `image` in one call, so a worker-backed host only
   * needs one round trip (one bitmap transfer, one pixel readback) per image.
   */
  analyzeImage(
    image: HTMLImageElement,
    avgLumHint: number | undefined,
    useWasm: boolean,
  ): Promise<CpuImageAnalysisResult | null>;
  /**
   * Average luminance only, no mask — the WebGL-backend path (no GPU device
   * to upload a mask to) and the last-resort fallback when every
   * `image-analysis` lane has already failed both need only this. Reports
   * `mode` for the same breadcrumb reason `analyzeImage` does: this path
   * bypasses `ChoresRuntime.runJob` entirely (there is no GPU device to run a
   * job against), so the caller — not `runtime.ts` — is the one that has to
   * publish it.
   */
  computeAverageLuminance(
    image: HTMLImageElement,
    useWasm: boolean,
  ): Promise<{ avgLuminance: number; mode: 'worker' | 'inline' }>;
}

/** The facade other apps call. */
export interface ChoresRuntime {
  /** Overloaded so callers get back the output type their job's `op` implies. */
  runJob(job: ImageAnalysisJob): Promise<ChoreResult<ImageAnalysisOutput>>;
  runJob(job: CoincidenceJob): Promise<ChoreResult<GpuCoincidenceOutput>>;
  runJob(job: MotionFieldJob): Promise<ChoreResult<MotionFieldOutput>>;
  /** Lanes currently registered and reporting themselves usable. */
  availableBackends(): readonly ChoreBackend[];
  destroy(): void;
}
