import {
  CpuChoreBackend,
  createChoresRuntime,
  publishMotionFieldEnergy,
  type ChoresRuntime,
  type CpuChoreHost,
  type CpuMotionFieldOutput,
} from './compute/chores';
import { MOTION_FIELD_DIVISOR } from './motionModes';

/**
 * Motion field for the WebGL diagnostic backend (and anything else without a
 * compute lane).
 *
 * The frame is drawn into a canvas already at *field* resolution — one
 * `drawImage` the browser box-filters for us — and the chore then runs with a
 * divisor of 1. Reading pixels back at a 480×270 field instead of 1920×1080
 * is the difference between a `getImageData` that fits in a frame and one that
 * does not, and it produces the same averages the WGSL kernel computes
 * in-shader.
 *
 * Lane selection still goes through the facade, so `window.motionFieldBackend`
 * and `window.motionFieldReason` record which of `wasm` / `ts` served the
 * frame and why the other declined — exactly the `gpuChoreBackend` convention.
 */
export class LiveMotionSampler {
  private readonly runtime: ChoresRuntime;
  private canvas: HTMLCanvasElement | null = null;
  private context: CanvasRenderingContext2D | null = null;
  /** One sample in flight at a time; a tick during a sample is dropped. */
  private busy = false;
  private resetPending = true;
  private lastOutput: CpuMotionFieldOutput | null = null;

  constructor(host: CpuChoreHost) {
    // The CPU lanes hold the previous frame's luminance, so this runtime has to
    // outlive a single tick — hence one sampler per live source, not one per
    // call.
    this.runtime = createChoresRuntime([
      new CpuChoreBackend('wasm', host),
      new CpuChoreBackend('ts', host),
    ]);
  }

  /** Drop the frame history: a new source, a seek, or a resolution change. */
  reset(): void {
    this.resetPending = true;
    this.lastOutput = null;
  }

  /** Most recent field, or `null` before the first successful sample. */
  getField(): CpuMotionFieldOutput | null {
    return this.lastOutput;
  }

  /**
   * Sample `video` and store the resulting field. Fire-and-forget: a tick that
   * arrives while the previous sample is still running is dropped rather than
   * queued, so a slow frame cannot build a backlog.
   */
  async sample(video: HTMLVideoElement, threshold: number): Promise<CpuMotionFieldOutput | null> {
    if (this.busy) return this.lastOutput;
    const sourceWidth = video.videoWidth;
    const sourceHeight = video.videoHeight;
    if (sourceWidth <= 0 || sourceHeight <= 0) return this.lastOutput;

    const width = Math.max(1, Math.ceil(sourceWidth / MOTION_FIELD_DIVISOR));
    const height = Math.max(1, Math.ceil(sourceHeight / MOTION_FIELD_DIVISOR));

    this.busy = true;
    try {
      const context = this.ensureContext(width, height);
      if (!context) return this.lastOutput;
      context.drawImage(video, 0, 0, width, height);
      const pixels = context.getImageData(0, 0, width, height);

      const result = await this.runtime.runJob({
        op: 'motion-field',
        pixels: { data: pixels.data, width, height },
        width,
        height,
        // The canvas already did the downsample; the kernel differences 1:1.
        divisor: 1,
        threshold,
        reset: this.resetPending,
      });
      this.resetPending = false;

      if (!result.ok || result.value.kind !== 'cpu-motion-field') {
        this.lastOutput = null;
        publishMotionFieldEnergy(0);
        return null;
      }
      this.lastOutput = result.value;
      publishMotionFieldEnergy(result.value.stats.meanMagnitude);
      return result.value;
    } finally {
      this.busy = false;
    }
  }

  destroy(): void {
    this.runtime.destroy();
    this.canvas = null;
    this.context = null;
    this.lastOutput = null;
  }

  private ensureContext(width: number, height: number): CanvasRenderingContext2D | null {
    if (!this.canvas) {
      if (typeof document === 'undefined') return null;
      this.canvas = document.createElement('canvas');
      this.context = null;
    }
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
      // A resize invalidates the history: cells no longer line up frame to frame.
      this.resetPending = true;
    }
    this.context ??= this.canvas.getContext('2d', { willReadFrequently: true });
    return this.context;
  }
}
