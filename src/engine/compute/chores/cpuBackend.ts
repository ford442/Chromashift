/**
 * `gpu-chores` — WASM and TypeScript lanes.
 *
 * Both lanes share one host implementation and differ only in the `useWasm`
 * flag threaded into `CpuChoreHost.analyzeImage`, exactly how the pre-facade
 * code chose between them. The WASM lane declines when the WASM module is not
 * ready, so `auto` slides to `ts` rather than silently producing nothing.
 *
 * These lanes return a `Uint8Array` mask. Uploading it into an `r8uint`
 * texture stays with the caller: the kit does not own a device on this path.
 */

import {
  downsampleLuminance,
  lucasKanadeFlow,
  motionMagnitudeField,
  summariseMotionField,
  type LuminancePlane,
} from './motionKernel';
import type {
  ChoreBackend,
  ChoreBackendImpl,
  ChoreJob,
  ChoreOutput,
  CpuChoreHost,
  CpuMotionFieldOutput,
  ImageAnalysisJob,
  MotionFieldJob,
} from './types';

export type { CpuChoreHost, CpuImageAnalysisResult } from './types';

export class CpuChoreBackend implements ChoreBackendImpl {
  readonly backend: ChoreBackend;

  private readonly host: CpuChoreHost;
  private readonly useWasm: boolean;
  /** Set by the last successful `run()`, read by `breadcrumbLabel()`. */
  private lastMode: 'worker' | 'inline' | null = null;
  /**
   * Previous frame's downsampled luminance, owned by the lane so a caller only
   * ever hands over the current frame. Dropped on a `reset` job or whenever the
   * field geometry changes.
   */
  private previousLuminance: LuminancePlane | null = null;

  constructor(backend: 'wasm' | 'ts', host: CpuChoreHost) {
    this.backend = backend;
    this.host = host;
    this.useWasm = backend === 'wasm';
  }

  canRun(job: ChoreJob): boolean {
    if (job.op === 'motion-field') {
      if (!job.pixels) return false;
      // The `ts` lane always has a kernel — the host's, or the portable one
      // compiled into this file; the `wasm` lane needs both a loaded module and
      // a host that actually supplies one.
      if (!this.useWasm) return true;
      return this.host.isWasmReady() && typeof this.host.motionField === 'function';
    }
    if (job.op !== 'image-analysis') return false;
    if (!job.image) return false;
    if (this.useWasm && !this.host.isWasmReady()) return false;
    return true;
  }

  declineReason(job: ChoreJob): string {
    if (job.op === 'motion-field') {
      if (!job.pixels) return 'No decoded frame pixels';
      if (!this.host.isWasmReady()) return 'WASM module not ready';
      return 'Host supplies no WASM motion-field kernel';
    }
    if (job.op !== 'image-analysis') return 'CPU lanes do not support this op — GPU compute only';
    if (!job.image) return 'No CPU-decodable source image';
    if (this.useWasm && !this.host.isWasmReady()) return 'WASM module not ready';
    return 'Unavailable';
  }

  async run(job: ChoreJob): Promise<ChoreOutput | null> {
    if (!this.canRun(job)) return null;
    if (job.op === 'motion-field') {
      return this.runMotionField(job);
    }
    const analysisJob = job as ImageAnalysisJob;
    const image = analysisJob.image!;

    const result = await this.host.analyzeImage(image, analysisJob.avgLumHint, this.useWasm);
    if (!result) return null;
    this.lastMode = result.mode;

    return {
      kind: 'cpu-mask',
      avgLuminance: result.avgLuminance,
      mask: result.mask,
      width: result.width,
      height: result.height,
    };
  }

  breadcrumbLabel(): string {
    return this.lastMode ? `${this.backend}-${this.lastMode}` : this.backend;
  }

  /**
   * Motion field over decoded pixels: the frame-difference magnitude always,
   * plus the Lucas–Kanade flow vector when the job asked for one.
   *
   * Returns `Float32Array`s sized to the field, not the frame — at the default
   * quarter-scale divisor that is 1/16 of the frame for the magnitude and 1/8
   * for the flow, which is the "small array" the CPU contract allows, not a
   * full-image readback.
   */
  private async runMotionField(job: MotionFieldJob): Promise<CpuMotionFieldOutput | null> {
    const pixels = job.pixels;
    if (!pixels) return null;
    const divisor = Math.max(1, Math.floor(job.divisor ?? 4));

    const wantFlow = job.flow === true;

    // A host kernel serves either lane. That is what lets a worker-backed host
    // keep the LK solve off the animation thread while `prefer: 'ts'` still
    // means the portable kernel — see `CpuMotionFieldHost`.
    if (typeof this.host.motionField === 'function') {
      const hosted = await this.host.motionField(
        pixels, divisor, job.threshold, job.reset === true, wantFlow, this.useWasm,
      );
      if (!hosted) return null;
      // The host owns its own history; the in-process history stays dropped so
      // a later lane switch cannot difference against a stale frame.
      this.previousLuminance = null;
      this.lastMode = hosted.mode ?? 'inline';
      return {
        kind: 'cpu-motion-field',
        field: hosted.field,
        flow: wantFlow ? (hosted.flow ?? null) : null,
        width: hosted.width,
        height: hosted.height,
        stats: summariseMotionField(hosted.field),
      };
    }

    const current = downsampleLuminance(pixels, divisor);
    const previous = job.reset === true ? null : this.previousLuminance;
    const field = motionMagnitudeField(current, previous, job.threshold);
    // Solved only when asked for: `boost`/`gate` read magnitude alone, and the
    // LK pyramid is several times the cost of the difference that feeds it.
    const flow = wantFlow ? lucasKanadeFlow(current, previous).flow : null;
    this.previousLuminance = current;
    this.lastMode = 'inline';

    return {
      kind: 'cpu-motion-field',
      field,
      flow,
      width: current.width,
      height: current.height,
      stats: summariseMotionField(field),
    };
  }
}
