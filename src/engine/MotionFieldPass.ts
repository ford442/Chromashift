import type { WebGpuChoreBackend } from './compute/chores/webgpuBackend';
import { acquireGpuChoreSession, type GpuChoreLease } from './compute/GpuChoreSession';
import {
  EMPTY_MOTION_FIELD_STATS,
  publishMotionFieldBreadcrumbs,
  publishMotionFieldEnergy,
  publishMotionFieldHasFlow,
  type MotionFieldStats,
} from './compute/chores';
import { packMotionFieldRgba16 } from './halfFloat';
import { MOTION_FIELD_DIVISOR } from './motionModes';
import type { CpuMotionField } from './types/RendererContracts';

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
 *
 * When the GPU lane declines (`?no_gpu_compute`, no compute on the device, an
 * oversize source), `useLiveSource` runs the chore's CPU lane instead and
 * hands the result to {@link MotionFieldPass.setCpuField}, which uploads it
 * into an `rgba16float` texture with the same channel layout the GPU lane
 * writes. `encodeAndSubmit` returns that texture on decline, so
 * `PersistencePass` needs no separate variant for it.
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
  /** True after the GPU lane declined; cleared on its next success. */
  private gpuDeclined = false;
  private cpuTexture: GPUTexture | null = null;
  private cpuHasFlow = false;
  private cpuPacked: Uint16Array<ArrayBuffer> | undefined;
  /** Whether the texture last returned by `encodeAndSubmit` is the CPU upload. */
  private servingCpu = false;

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
   * True when the CPU lane has to supply the field: the device has no compute
   * lane, or the last encode declined. Gates `useLiveSource`'s sampler, so a
   * healthy WebGPU device never pays for `getImageData`.
   */
  wantsCpuField(): boolean {
    return !this.backend.isSupported() || this.gpuDeclined;
  }

  /**
   * Upload the CPU lane's field (`r` = magnitude, `gb` = flow or zero, `a` = 1).
   * `null` drops it, so a decline falls back to the no-motion variant rather
   * than reading a stale field.
   */
  setCpuField(motion: CpuMotionField | null): void {
    if (!motion || motion.width <= 0 || motion.height <= 0) {
      this.cpuTexture?.destroy();
      this.cpuTexture = null;
      this.cpuHasFlow = false;
      return;
    }
    const { width, height } = motion;
    if (!this.cpuTexture || this.cpuTexture.width !== width || this.cpuTexture.height !== height) {
      this.cpuTexture?.destroy();
      this.cpuTexture = this.device.createTexture({
        label: 'motion-field-cpu',
        size: [width, height, 1],
        format: 'rgba16float',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      });
    }
    this.cpuPacked = packMotionFieldRgba16(motion, this.cpuPacked);
    this.cpuHasFlow = Boolean(motion.flow) && motion.flow!.length >= width * height * 2;
    this.device.queue.writeTexture(
      { texture: this.cpuTexture },
      this.cpuPacked,
      { bytesPerRow: width * 8, rowsPerImage: height },
      [width, height, 1],
    );
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
   * Returns the field/flow texture; on decline or failure, the CPU lane's
   * uploaded field if there is one, else `null`.
   */
  encodeAndSubmit(
    source: GPUTexture,
    width: number,
    height: number,
    options: MotionFieldEncodeOptions,
    wantFlow: boolean,
  ): GPUTexture | null {
    if (!this.backend.isSupported()) {
      return this.decline(this.backend.support.reason ?? 'WebGPU compute unavailable');
    }
    if (!this.backend.canAnalyze(width, height)) {
      return this.decline(`Motion source ${width}×${height} exceeds maxTextureDimension2D`);
    }

    try {
      const enc = this.device.createCommandEncoder();
      const output = this.backend.encodeMotionFieldInto(enc, source, width, height, {
        divisor: MOTION_FIELD_DIVISOR,
        threshold: options.threshold,
        reset: options.reset === true,
      });
      if (!output) {
        return this.decline('Motion lane produced no field');
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
      this.gpuDeclined = false;
      this.servingCpu = false;
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
      return this.decline(error instanceof Error ? error.message : String(error));
    }
  }

  /** True when the last encoded frame carried a solved velocity in `gb`. */
  hasFlowField(): boolean {
    return this.servingCpu ? this.cpuHasFlow : this.backend.hasMotionFlow();
  }

  /**
   * Refresh `window.motionFieldEnergy` at most every {@link STATS_INTERVAL_MS}.
   * Called after the frame is submitted, so the map never sits inside the
   * encode path.
   */
  afterSubmit(now = performance.now()): void {
    // The CPU lane's sampler publishes its own energy.
    if (this.servingCpu) return;
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
    this.setCpuField(null);
    this.lease.release();
  }

  /**
   * GPU lane declined: serve the CPU upload if there is one. Its breadcrumbs
   * (`wasm-worker` / `ts-worker`) come from the sampler's chore runtime, so
   * only a decline with nothing to fall back on publishes here.
   */
  private decline(reason: string): GPUTexture | null {
    this.gpuDeclined = true;
    if (this.cpuTexture) {
      this.fieldTexture = this.cpuTexture;
      this.servingCpu = true;
      // Force a re-publish if the GPU lane later recovers or the CPU field drops.
      this.lastBackend = null;
      this.lastReason = null;
      publishMotionFieldHasFlow(this.cpuHasFlow);
      return this.cpuTexture;
    }
    this.servingCpu = false;
    this.publishDecline(reason);
    return null;
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
