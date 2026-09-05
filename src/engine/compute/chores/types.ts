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
export type ChoreOp = 'image-analysis' | 'coincidence';

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

export type ChoreJob = ImageAnalysisJob | CoincidenceJob;

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

export type ChoreOutput = ImageAnalysisOutput | GpuCoincidenceOutput;

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
  destroy?(): void;
}

/** The facade other apps call. */
export interface ChoresRuntime {
  /** Overloaded so callers get back the output type their job's `op` implies. */
  runJob(job: ImageAnalysisJob): Promise<ChoreResult<ImageAnalysisOutput>>;
  runJob(job: CoincidenceJob): Promise<ChoreResult<GpuCoincidenceOutput>>;
  /** Lanes currently registered and reporting themselves usable. */
  availableBackends(): readonly ChoreBackend[];
  destroy(): void;
}
