/**
 * `gpu-chores` — WebGPU compute lane.
 *
 * The facade over three passes, one module each: image analysis (histogram
 * + classification mask, `webgpuAnalysis.ts`), coincidence
 * (`webgpuCoincidence.ts`) and the motion field and its flow
 * (`webgpuMotion.ts`). This class decides which jobs the device can run and
 * says why it declines the rest; each pass owns its pipelines and textures,
 * built on first use as one non-null resources object.
 *
 * Device policy: this lane **adopts** a `GPUDevice` handed to it by the
 * renderer. It must never call `requestAdapter`/`requestDevice` — a second
 * device is the exact regression the kit is meant to make impossible.
 */

import {
  canAnalyzeTexture,
  detectGpuComputeSupport,
  supportsR8uintStorage,
  type GpuComputeSupport,
} from './support';
import type { MotionFieldStats } from './motionKernel';
import type { LayerTextures } from '../../webgpu/bindGroups';
import type {
  ChoreBackendImpl,
  ChoreJob,
  ChoreOutput,
  GpuImageAnalysisOutput,
  GpuMotionFieldOutput,
  MotionFieldJob,
} from './types';
import { GpuImageAnalysisPass } from './webgpuAnalysis';
import { GpuCoincidencePass, type CoincidenceEncodeParams } from './webgpuCoincidence';
import { GpuMotionPass, type MotionFieldEncodeParams } from './webgpuMotion';

export { averageFromHistogram } from './webgpuAnalysis';
export type { CoincidenceEncodeParams } from './webgpuCoincidence';
export type { MotionFieldEncodeParams } from './webgpuMotion';

/**
 * Break-even note: the GPU lane wins on large images (4K–8K), where the two
 * compute passes dwarf the fixed cost of pipeline setup plus the one 1 KiB
 * histogram map. Small stills are dominated by that fixed cost and by
 * `mapAsync` latency, so they are generally no faster than the WASM lane —
 * they are still routed here when a GPU texture already exists, because the
 * alternative is a CPU decode of an image the GPU is already holding.
 * Revisit with a microbench before adding a resolution floor.
 */
export class WebGpuChoreBackend implements ChoreBackendImpl {
  readonly backend = 'webgpu' as const;

  private readonly device: GPUDevice;
  readonly support: GpuComputeSupport;
  /**
   * The classification kernel writes a `texture_storage_2d<r8uint, write>`,
   * and `r8uint` is only a storage format under `texture-formats-tier1`.
   * Without it every object in the chain is invalid — but invalid objects are
   * not exceptions, so `analyze()` used to "succeed" with an invalid mask
   * texture that the renderer then bound into every layer pass, dropping each
   * frame's command buffer and leaving the canvas black. Declining here lets
   * the runtime fall through to the WASM/TS lanes, whose mask is uploaded with
   * `writeTexture` (sampling `r8uint` is core).
   */
  private readonly maskStorageSupported: boolean;

  private readonly analysis: GpuImageAnalysisPass;
  private readonly coincidence: GpuCoincidencePass;
  private readonly motion: GpuMotionPass;

  constructor(device: GPUDevice) {
    this.device = device;
    this.support = detectGpuComputeSupport(device);
    this.maskStorageSupported = supportsR8uintStorage(device);
    this.analysis = new GpuImageAnalysisPass(device);
    this.coincidence = new GpuCoincidencePass(device);
    this.motion = new GpuMotionPass(device);
  }

  isSupported(): boolean {
    return this.support.available;
  }

  canAnalyze(width: number, height: number): boolean {
    return canAnalyzeTexture(this.support, width, height);
  }

  canRun(job: ChoreJob): boolean {
    if (job.op === 'coincidence') {
      return Boolean(job.layers) && this.canAnalyze(job.width, job.height);
    }
    if (!job.source) return false;
    if (job.op === 'image-analysis' && !this.maskStorageSupported) return false;
    return this.canAnalyze(job.width, job.height);
  }

  declineReason(job: ChoreJob): string {
    if (!this.support.available) return this.support.reason ?? 'WebGPU compute unavailable';
    if (job.op === 'image-analysis' && !this.maskStorageSupported) {
      return 'r8uint storage textures need texture-formats-tier1, which this device was not granted';
    }
    if (job.op === 'coincidence') {
      if (!job.layers) return 'No GPU-resident layer textures';
      return `Coincidence buffer ${job.width}×${job.height} exceeds maxTextureDimension2D `
        + `(${this.support.maxTextureDimension2D})`;
    }
    if (job.op === 'motion-field') {
      if (!job.source) return 'No GPU-resident source frame';
      return `Motion source ${job.width}×${job.height} exceeds maxTextureDimension2D `
        + `(${this.support.maxTextureDimension2D})`;
    }
    if (!job.source) return 'No GPU-resident source texture';
    return `Image ${job.width}×${job.height} exceeds maxTextureDimension2D `
      + `(${this.support.maxTextureDimension2D})`;
  }

  async run(job: ChoreJob): Promise<ChoreOutput | null> {
    if (!this.canRun(job)) return null;
    switch (job.op) {
      case 'coincidence':
        return this.coincidence.run(job);
      case 'motion-field':
        return this.runMotionField(job);
      case 'image-analysis':
        return job.source ? this.analyze(job.source, job.width, job.height, job.avgLumHint) : null;
    }
  }

  // ── image-analysis ─────────────────────────────────────────────────────────

  /**
   * Build histogram (256 bins), derive average luminance, and write an r8uint
   * mask. The mask is a new texture, owned by the caller from here on
   * (`webgpuAnalysis.ts`).
   */
  async analyze(
    source: GPUTexture,
    width: number,
    height: number,
    avgLumHint?: number,
  ): Promise<GpuImageAnalysisOutput | null> {
    if (!this.maskStorageSupported || !this.canAnalyze(width, height)) return null;
    return this.analysis.analyze(source, width, height, avgLumHint);
  }

  /** Read back the last mask's bytes, for golden / e2e validation. */
  readMaskPixels(width: number, height: number): Promise<Uint8Array | null> {
    return this.analysis.readMaskPixels(width, height);
  }

  // ── coincidence ────────────────────────────────────────────────────────────

  /**
   * Encode the coincidence compute pass into a caller-owned encoder and
   * caller-owned output textures — no submit, no internal texture caching.
   * `cacheSlot`: the caller's own ping-pong index, so a stable set of inputs
   * hits the bind-group cache every frame.
   */
  encodeCoincidenceInto(
    enc: GPUCommandEncoder,
    layers: LayerTextures,
    stampTexture: GPUTexture,
    diagTexture: GPUTexture,
    width: number,
    height: number,
    params: CoincidenceEncodeParams,
    cacheSlot: 0 | 1 = 0,
  ): void {
    this.coincidence.encodeInto(enc, layers, stampTexture, diagTexture, width, height, params, cacheSlot);
  }

  // ── motion-field ───────────────────────────────────────────────────────────

  /**
   * One-shot motion-field job for the async kit facade (sibling apps, tests).
   * Chromashift's own render loop calls `encodeMotionFieldInto()` so the
   * dispatch lands in the same `GPUCommandEncoder` as the rest of the frame.
   */
  private runMotionField(job: MotionFieldJob): GpuMotionFieldOutput | null {
    const source = job.source;
    if (!source) return null;
    const enc = this.device.createCommandEncoder();
    let output = this.encodeMotionFieldInto(enc, source, job.width, job.height, {
      divisor: job.divisor ?? 4,
      threshold: job.threshold,
      reset: job.reset === true,
    });
    if (output && job.flow === true) {
      const flowTexture = this.encodeMotionFlowInto(enc);
      if (flowTexture) output = { ...output, fieldTexture: flowTexture, hasFlow: true };
    }
    this.device.queue.submit([enc.finish()]);
    return output;
  }

  /** Encode the motion-field compute pass into a caller-owned encoder (`webgpuMotion.ts`). */
  encodeMotionFieldInto(
    enc: GPUCommandEncoder,
    source: GPUTexture,
    width: number,
    height: number,
    params: MotionFieldEncodeParams,
  ): GpuMotionFieldOutput | null {
    if (!this.canAnalyze(width, height)) return null;
    return this.motion.encodeFieldInto(enc, source, width, height, params);
  }

  /**
   * The two Lucas–Kanade dispatches on top of this encoder's last field, and
   * the combined texture to bind instead; `null` before any field.
   */
  encodeMotionFlowInto(enc: GPUCommandEncoder): GPUTexture | null {
    return this.motion.encodeFlowInto(enc);
  }

  /** True when the last encoded frame carried a solved velocity in `gb`. */
  hasMotionFlow(): boolean {
    return this.motion.carriesFlow();
  }

  /** The field texture the last `encodeMotionFieldInto` wrote, if any. */
  getMotionFieldTexture(): GPUTexture | null {
    return this.motion.fieldTexture();
  }

  /** Last summary statistics read back; {@link pollMotionFieldStats} refreshes them. */
  getMotionFieldStats(): MotionFieldStats {
    return this.motion.stats();
  }

  /** Map the statistics buffer; a call while a map is in flight is dropped. */
  pollMotionFieldStats(): void {
    this.motion.pollStats();
  }

  destroy(): void {
    this.analysis.destroy();
    this.coincidence.destroy();
    this.motion.destroy();
  }
}
