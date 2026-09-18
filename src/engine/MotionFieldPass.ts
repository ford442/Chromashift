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
 * A thin owner around the `motion-field` chore's WebGPU lane: the dispatch is
 * encoded into the frame's own `GPUCommandEncoder` (like `coincidence`, and
 * for the same reason — an extra queue submission per frame is not worth a
 * quarter-resolution compute pass), and the resulting field stays a
 * `GPUTexture` that `PersistencePass` binds directly.
 *
 * The only thing that ever crosses back to the CPU is the summary statistic
 * behind `window.motionFieldEnergy`, mapped at {@link STATS_INTERVAL_MS}
 * rather than per frame.
 */
export class MotionFieldPass {
  private readonly lease: GpuChoreLease;
  private readonly backend: WebGpuChoreBackend;
  private fieldTexture: GPUTexture | null = null;
  private lastStatsAt = 0;
  /** Last published breadcrumb pair, so a steady state writes nothing per frame. */
  private lastBackend: string | null = null;
  private lastReason: string | null = null;

  constructor(device: GPUDevice) {
    // Borrowed, not constructed: analysis and coincidence share this backend.
    this.lease = acquireGpuChoreSession(device);
    this.backend = this.lease.backend;
  }

  /** True when this device can run the motion lane at all. */
  isSupported(): boolean {
    return this.backend.isSupported();
  }

  /**
   * Encode the field for `source` and publish breadcrumbs. Returns the field
   * texture, or `null` when the lane declined — in which case
   * `PersistencePass` falls back to the non-motion pipelines rather than
   * rendering a blank tracer.
   */
  encode(
    enc: GPUCommandEncoder,
    source: GPUTexture,
    width: number,
    height: number,
    options: MotionFieldEncodeOptions,
  ): GPUTexture | null {
    if (!this.backend.isSupported()) {
      this.publishDecline(this.backend.support.reason ?? 'WebGPU compute unavailable');
      return null;
    }
    if (!this.backend.canAnalyze(width, height)) {
      this.publishDecline(`Motion source ${width}×${height} exceeds maxTextureDimension2D`);
      return null;
    }

    const output = this.backend.encodeMotionFieldInto(enc, source, width, height, {
      divisor: MOTION_FIELD_DIVISOR,
      threshold: options.threshold,
      reset: options.reset === true,
    });
    if (!output) {
      this.publishDecline('Motion lane produced no field');
      return null;
    }

    this.fieldTexture = output.fieldTexture;
    publishMotionFieldHasFlow(false);
    if (this.lastBackend !== 'webgpu' || this.lastReason !== null) {
      this.lastBackend = 'webgpu';
      this.lastReason = null;
      publishMotionFieldBreadcrumbs('webgpu', null);
    }
    return this.fieldTexture;
  }

  /**
   * Encode the Lucas–Kanade dispatches on top of the field {@link encode} just
   * produced and swap in the combined `(magnitude, vx, vy, 1)` texture.
   *
   * Only `motionMode: 'direction'` calls this, and only after `encode` returned
   * a texture. A separate call rather than a flag on `encode` so the caller can
   * drop a timestamp marker between the two halves — that is what splits the
   * Perf HUD's `field` and `flow` numbers apart.
   */
  encodeFlow(enc: GPUCommandEncoder): GPUTexture | null {
    if (!this.fieldTexture) return null;
    const flowTexture = this.backend.encodeMotionFlowInto(enc);
    if (!flowTexture) {
      publishMotionFieldHasFlow(false);
      return null;
    }
    this.fieldTexture = flowTexture;
    publishMotionFieldHasFlow(true);
    return flowTexture;
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
