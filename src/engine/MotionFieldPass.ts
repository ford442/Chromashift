import type { WebGpuChoreBackend } from './compute/chores/webgpuBackend';
import { acquireGpuChoreSession, type GpuChoreLease } from './compute/GpuChoreSession';
import {
  EMPTY_MOTION_FIELD_STATS,
  publishMotionFieldBreadcrumbs,
  publishMotionFieldEnergy,
  publishMotionFieldHasFlow,
  type MotionFieldStats,
} from './compute/chores';
import { MOTION_FIELD_DIVISOR } from './motionModes';

/** How often the summary statistics are mapped back for the breadcrumb (ms). */
const STATS_INTERVAL_MS = 500;

export interface MotionFieldEncodeOptions {
  /** Noise floor on the normalised luminance difference, in [0,1). */
  threshold: number;
  /** Drop the previous-frame history (source switch, resize, unpause). */
  reset?: boolean;
}

/**
 * Per-frame motion field for the WebGPU renderer.
 *
 * A thin owner around the `motion-field` chore's WebGPU lane. Unlike
 * `coincidence` (still encoded into the caller's own frame encoder), the
 * dispatches here get their own `GPUCommandEncoder` and an immediate
 * `queue.submit()` — see {@link MotionFieldPass.encodeAndSubmit} for why. The
 * resulting field stays a `GPUTexture` that `PersistencePass` binds directly.
 *
 * The only thing that ever crosses back to the CPU is the summary statistic
 * behind `window.motionFieldEnergy`, mapped at {@link STATS_INTERVAL_MS}
 * rather than per frame.
 */
export class MotionFieldPass {
  private readonly device: GPUDevice;
  private readonly lease: GpuChoreLease;
  private readonly backend: WebGpuChoreBackend;
  private fieldTexture: GPUTexture | null = null;
  private lastStatsAt = 0;
  /** Last published breadcrumb pair, so a steady state writes nothing per frame. */
  private lastBackend: string | null = null;
  private lastReason: string | null = null;

  constructor(device: GPUDevice) {
    this.device = device;
    // Borrowed, not constructed: analysis and coincidence share this backend.
    this.lease = acquireGpuChoreSession(device);
    this.backend = this.lease.backend;
  }

  /** True when this device can run the motion lane at all. */
  isSupported(): boolean {
    return this.backend.isSupported();
  }

  /**
   * Encode this frame's motion field — and, when `wantFlow` is set, the
   * Lucas–Kanade flow dispatches on top of it — into their **own** command
   * buffer and submit it immediately, rather than recording into the caller's
   * frame encoder.
   *
   * #182 added the two flow dispatches on top of the original frame-difference
   * pass, all three sharing the frame's encoder with the colour passes. A
   * `GPUValidationError` anywhere in this backend — a stale bind group, a
   * device-specific limit, a future edit to the kernels — doesn't throw in JS;
   * it poisons the *whole command buffer* it was recorded into, silently, at
   * `submit()`. When that buffer also held the layer/persistence/compositor
   * passes, the entire visible frame went black even though only the motion
   * lane was actually broken. Recording and submitting here instead means a
   * failure can only ever cost this frame's motion update — `fieldTexture`
   * stays whatever it was (or `null`), `PersistencePass` takes its existing
   * no-motion path, and the colour passes the caller records afterward are
   * unaffected. The `try`/`catch` covers a synchronous throw for the same
   * reason: nothing about a declined motion lane may propagate into the
   * caller's encode path.
   *
   * Returns the field/flow texture, or `null` when the lane declined or
   * failed.
   */
  encodeAndSubmit(
    source: GPUTexture,
    width: number,
    height: number,
    options: MotionFieldEncodeOptions,
    wantFlow: boolean,
  ): GPUTexture | null {
    if (!this.backend.isSupported()) {
      this.publishDecline(this.backend.support.reason ?? 'WebGPU compute unavailable');
      return null;
    }
    if (!this.backend.canAnalyze(width, height)) {
      this.publishDecline(`Motion source ${width}×${height} exceeds maxTextureDimension2D`);
      return null;
    }

    try {
      const enc = this.device.createCommandEncoder();
      const output = this.backend.encodeMotionFieldInto(enc, source, width, height, {
        divisor: MOTION_FIELD_DIVISOR,
        threshold: options.threshold,
        reset: options.reset === true,
      });
      if (!output) {
        this.publishDecline('Motion lane produced no field');
        return null;
      }

      let fieldTexture = output.fieldTexture;
      let hasFlow = false;
      if (wantFlow) {
        const flowTexture = this.backend.encodeMotionFlowInto(enc);
        if (flowTexture) {
          fieldTexture = flowTexture;
          hasFlow = true;
        }
      }

      this.device.queue.submit([enc.finish()]);

      this.fieldTexture = fieldTexture;
      publishMotionFieldHasFlow(hasFlow);
      if (this.lastBackend !== 'webgpu' || this.lastReason !== null) {
        this.lastBackend = 'webgpu';
        this.lastReason = null;
        publishMotionFieldBreadcrumbs('webgpu', null);
      }
      return this.fieldTexture;
    } catch (error) {
      console.warn(
        '[MotionFieldPass] motion encode failed; composite continues without it:',
        error,
      );
      this.publishDecline(error instanceof Error ? error.message : String(error));
      return null;
    }
  }

  /** True when the last encoded frame carried a solved velocity in `gb`. */
  hasFlowField(): boolean {
    return this.backend.hasMotionFlow();
  }

  /**
   * Refresh `window.motionFieldEnergy` at most every {@link STATS_INTERVAL_MS}.
   * Called after the frame is submitted, so the map never sits inside the
   * encode path.
   */
  afterSubmit(now = performance.now()): void {
    if (now - this.lastStatsAt < STATS_INTERVAL_MS) return;
    this.lastStatsAt = now;
    this.backend.pollMotionFieldStats();
    publishMotionFieldEnergy(this.backend.getMotionFieldStats().meanMagnitude);
  }

  getStats(): MotionFieldStats {
    return this.backend.isSupported()
      ? this.backend.getMotionFieldStats()
      : EMPTY_MOTION_FIELD_STATS;
  }

  getFieldTexture(): GPUTexture | null {
    return this.fieldTexture;
  }

  destroy(): void {
    this.fieldTexture = null;
    this.lease.release();
  }

  private publishDecline(reason: string): void {
    this.fieldTexture = null;
    publishMotionFieldHasFlow(false);
    if (this.lastReason === reason && this.lastBackend === null) return;
    this.lastBackend = null;
    this.lastReason = reason;
    publishMotionFieldBreadcrumbs(null, reason);
    publishMotionFieldEnergy(0);
  }
}
