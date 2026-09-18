/** Per-pass GPU timings derived from WebGPU timestamp queries (nanoseconds → ms). */
export interface GpuPassTimings {
  layersMs: number;
  /** Quarter-resolution motion field (`motion-field` chore); 0 when off. */
  motionMs: number;
  /**
   * Lucas–Kanade flow, the two extra dispatches `motionMode: 'direction'` adds
   * on top of the frame difference; 0 in every other mode. Split out because
   * "Motion" jumping when the mode changes is otherwise unattributable.
   */
  motionFlowMs: number;
  persistenceMs: number;
  compositorMs: number;
  readbackMs: number;
  totalGpuMs: number;
}

export const GPU_TIMESTAMP_MARKERS = 7;
export const GPU_TIMING_HISTORY_SIZE = 120;

const QUERIES_PER_FRAME = GPU_TIMESTAMP_MARKERS;
const BYTES_PER_QUERY = 8;
const RESOLVE_SLOTS = 2;
/** Bytes a frame's markers actually occupy (7 × 8 = 56). */
const SLOT_PAYLOAD_BYTES = QUERIES_PER_FRAME * BYTES_PER_QUERY;
/**
 * `resolveQuerySet`'s destination offset must be a multiple of 256, so the
 * per-frame slots are padded out to that stride rather than packed end to end.
 * Packing them put slot 1 at offset 48, which failed validation and — because
 * the resolve shares the frame's command encoder — threw away the whole
 * command buffer on every other frame. That is the steady black blink the
 * Perf HUD used to produce.
 */
const SLOT_STRIDE_BYTES = 256;
const TIMING_BUFFER_BYTES = SLOT_STRIDE_BYTES * RESOLVE_SLOTS;

export interface GpuTimestampCreateResult {
  profiler: GpuTimestampProfiler | null;
  reason?: string;
}

export interface BandwidthEstimateInput {
  canvasW: number;
  canvasH: number;
  layerScale: number;
  tracerScale: number;
  sampleCount: number;
  readbackActive: boolean;
  /** Bytes per texel of internal layer/tracer targets (4 for rgba8 / rg11b10, 8 for rgba16float). */
  internalBytesPerPixel?: number;
  /** Motion field active this frame — adds a quarter-scale read/write pair. */
  motionActive?: boolean;
  /** Lucas–Kanade flow active this frame — two more quarter-scale passes. */
  motionFlowActive?: boolean;
  /** Field resolution divisor (4 = quarter scale). */
  motionDivisor?: number;
}

/** Rough read/write traffic model for internal colour targets. */
export function estimatePassBandwidthMBps(
  dims: BandwidthEstimateInput,
  timings: GpuPassTimings,
): number {
  const bytesPerPixel = dims.internalBytesPerPixel ?? 4;
  const lw = Math.max(1, Math.round(dims.canvasW * dims.layerScale));
  const lh = Math.max(1, Math.round(dims.canvasH * dims.layerScale));
  const tw = Math.max(1, Math.round(dims.canvasW * dims.tracerScale));
  const th = Math.max(1, Math.round(dims.canvasH * dims.tracerScale));
  const layerPixels = lw * lh;
  const tracerPixels = tw * th;
  const canvasPixels = dims.canvasW * dims.canvasH;
  const msaaFactor = dims.sampleCount > 1 ? dims.sampleCount : 1;

  const layersBytes = layerPixels * bytesPerPixel * (3 + 1) * msaaFactor;
  const persistBytes = layerPixels * bytesPerPixel * 3 + tracerPixels * bytesPerPixel * 4;
  const compositorBytes = canvasPixels * bytesPerPixel * 2 + layerPixels * bytesPerPixel * 3;
  const readbackBytes = dims.readbackActive ? 128 * 128 * 4 + 64 * 64 * 4 : 0;
  // The motion pass reads the source once and writes a field plus a luminance
  // history plane, both at 1/divisor^2 of the source area.
  const motionDivisor = Math.max(1, dims.motionDivisor ?? 4);
  const motionCells = canvasPixels / (motionDivisor * motionDivisor);
  const motionBytes = dims.motionActive
    ? canvasPixels * bytesPerPixel + motionCells * (8 + 4) * 2
    : 0;
  // The coarse pass reads both history planes at 9 taps of a 2×2 average and
  // writes a quarter of a field; the refine pass reads both planes plus the
  // coarse seed and the magnitude, and writes a full field.
  const motionFlowBytes = dims.motionActive && dims.motionFlowActive
    ? motionCells * (4 * 9 * 2 / 4 + 8 / 4) + motionCells * (4 * 9 * 2 + 8 + 8 + 8)
    : 0;

  const totalBytes = layersBytes + persistBytes + compositorBytes + readbackBytes
    + motionBytes + motionFlowBytes;
  const totalMs = Math.max(timings.totalGpuMs, 0.001);
  return (totalBytes / (1024 * 1024)) / (totalMs / 1000);
}

export function parseTimestampMarkers(
  stamps: BigUint64Array,
  timestampPeriodNs: number,
): GpuPassTimings {
  const toMs = (start: bigint, end: bigint) =>
    Number(end - start) * timestampPeriodNs / 1_000_000;

  return {
    layersMs: toMs(stamps[0], stamps[1]),
    motionMs: toMs(stamps[1], stamps[2]),
    motionFlowMs: toMs(stamps[2], stamps[3]),
    persistenceMs: toMs(stamps[3], stamps[4]),
    compositorMs: toMs(stamps[4], stamps[5]),
    readbackMs: toMs(stamps[5], stamps[6]),
    totalGpuMs: toMs(stamps[0], stamps[6]),
  };
}

function resolveTimestampPeriodNs(device: GPUDevice): number {
  const queue = device.queue as GPUQueue & { getTimestampPeriod?: () => number };
  const limits = device.limits as GPUSupportedLimits & { timestampPeriod?: number };
  return typeof queue.getTimestampPeriod === 'function'
    ? queue.getTimestampPeriod()
    : (limits.timestampPeriod ?? 1);
}

/**
 * WebGPU timestamp-query profiler.
 *
 * Spec: `MAP_READ` may only be combined with `COPY_DST`. Resolve into a
 * `QUERY_RESOLVE | COPY_SRC` buffer, then `copyBufferToBuffer` into a
 * `MAP_READ | COPY_DST` readback. Two slots so the previous frame can map
 * while the current frame resolves.
 *
 * Allocation or a zero timestamp period skips GPU timing (CPU `performance.now()`
 * in the renderer stays the HUD fallback) — never fail renderer init.
 */
export class GpuTimestampProfiler {
  private readonly querySet: GPUQuerySet;
  private readonly resolveBuffer: GPUBuffer;
  private readonly readbackBuffer: GPUBuffer;
  private readonly timestampPeriodNs: number;
  private enabled = false;
  private writeSlot = 0;
  private pendingSlot: number | null = null;
  private mapPending = false;

  private lastTimings: GpuPassTimings | null = null;
  private readonly history: number[] = [];
  private approxBandwidthMBps = 0;
  private bandwidthInput: BandwidthEstimateInput | null = null;

  static create(device: GPUDevice): GpuTimestampCreateResult {
    if (!device.features.has('timestamp-query')) {
      return { profiler: null, reason: 'timestamp-query not granted' };
    }

    // `GPUCommandEncoder.writeTimestamp` is an optional Dawn extension, not
    // core WebGPU. Calling a missing method mid-encode would abandon the frame
    // *after* the swap-chain texture was acquired — i.e. present a black
    // frame — so the profiler opts out up front instead.
    if (typeof GPUCommandEncoder !== 'undefined'
        && typeof GPUCommandEncoder.prototype.writeTimestamp !== 'function') {
      return { profiler: null, reason: 'encoder timestamps unavailable; using CPU timing' };
    }

    const timestampPeriodNs = resolveTimestampPeriodNs(device);
    if (!(timestampPeriodNs > 0)) {
      return { profiler: null, reason: 'timestamp period is 0; using CPU timing' };
    }

    let querySet: GPUQuerySet | undefined;
    let resolveBuffer: GPUBuffer | undefined;
    let readbackBuffer: GPUBuffer | undefined;
    try {
      querySet = device.createQuerySet({
        type: 'timestamp',
        count: QUERIES_PER_FRAME,
      });
      // MAP_READ may only pair with COPY_DST — never QUERY_RESOLVE / COPY_SRC.
      resolveBuffer = device.createBuffer({
        size: TIMING_BUFFER_BYTES,
        usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
      });
      readbackBuffer = device.createBuffer({
        size: TIMING_BUFFER_BYTES,
        usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
      });
      return {
        profiler: new GpuTimestampProfiler(querySet, resolveBuffer, readbackBuffer, timestampPeriodNs),
      };
    } catch (error) {
      querySet?.destroy();
      resolveBuffer?.destroy();
      readbackBuffer?.destroy();
      console.warn(
        '[GpuTimestampProfiler] timestamp-query buffers unavailable; using CPU timing',
        error,
      );
      return { profiler: null, reason: 'timestamp-query buffers unavailable; using CPU timing' };
    }
  }

  private constructor(
    querySet: GPUQuerySet,
    resolveBuffer: GPUBuffer,
    readbackBuffer: GPUBuffer,
    timestampPeriodNs: number,
  ) {
    this.querySet = querySet;
    this.resolveBuffer = resolveBuffer;
    this.readbackBuffer = readbackBuffer;
    this.timestampPeriodNs = timestampPeriodNs;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  setBandwidthInput(input: BandwidthEstimateInput): void {
    this.bandwidthInput = input;
  }

  beginFrame(enc: GPUCommandEncoder): void {
    if (!this.enabled) return;
    enc.writeTimestamp(this.querySet, 0);
  }

  markLayersEnd(enc: GPUCommandEncoder): void {
    if (!this.enabled) return;
    enc.writeTimestamp(this.querySet, 1);
  }

  /**
   * End of the motion-field (frame-difference) compute dispatch. Always
   * written, even when the pass did not run, so the marker indices stay fixed
   * and a `motionMs` of 0 reads as "no motion work this frame" rather than
   * shifting every later row.
   */
  markMotionEnd(enc: GPUCommandEncoder): void {
    if (!this.enabled) return;
    enc.writeTimestamp(this.querySet, 2);
  }

  /**
   * End of the Lucas–Kanade flow dispatches. Written unconditionally for the
   * same reason as {@link markMotionEnd}: with no flow pass this collapses onto
   * the previous marker and `motionFlowMs` reads 0.
   */
  markMotionFlowEnd(enc: GPUCommandEncoder): void {
    if (!this.enabled) return;
    enc.writeTimestamp(this.querySet, 3);
  }

  markPersistenceEnd(enc: GPUCommandEncoder): void {
    if (!this.enabled) return;
    enc.writeTimestamp(this.querySet, 4);
  }

  markCompositorEnd(enc: GPUCommandEncoder): void {
    if (!this.enabled) return;
    enc.writeTimestamp(this.querySet, 5);
  }

  finishFrame(enc: GPUCommandEncoder): void {
    if (!this.enabled) return;
    enc.writeTimestamp(this.querySet, 6);
    const slot = this.writeSlot;
    const offset = slot * SLOT_STRIDE_BYTES;
    enc.resolveQuerySet(
      this.querySet,
      0,
      QUERIES_PER_FRAME,
      this.resolveBuffer,
      offset,
    );
    enc.copyBufferToBuffer(
      this.resolveBuffer,
      offset,
      this.readbackBuffer,
      offset,
      SLOT_PAYLOAD_BYTES,
    );
    this.pendingSlot = slot;
    this.writeSlot = (this.writeSlot + 1) % RESOLVE_SLOTS;
  }

  afterSubmit(): void {
    if (!this.enabled || this.pendingSlot === null || this.mapPending) return;
    const slot = this.pendingSlot;
    this.pendingSlot = null;
    this.mapPending = true;
    const offset = slot * SLOT_STRIDE_BYTES;
    const byteLength = SLOT_PAYLOAD_BYTES;

    void this.readbackBuffer.mapAsync(GPUMapMode.READ, offset, byteLength).then(() => {
      const stamps = new BigUint64Array(
        this.readbackBuffer.getMappedRange(offset, byteLength),
      );
      const timings = parseTimestampMarkers(stamps, this.timestampPeriodNs);
      this.readbackBuffer.unmap();
      this.mapPending = false;
      this.lastTimings = timings;
      this.pushHistory(timings.totalGpuMs);
      if (this.bandwidthInput) {
        this.approxBandwidthMBps = estimatePassBandwidthMBps(this.bandwidthInput, timings);
      }
    }).catch(() => {
      this.mapPending = false;
    });
  }

  private pushHistory(totalGpuMs: number): void {
    this.history.push(totalGpuMs);
    if (this.history.length > GPU_TIMING_HISTORY_SIZE) {
      this.history.shift();
    }
  }

  getSnapshot(): {
    available: true;
    last: GpuPassTimings | null;
    history: readonly number[];
    approxBandwidthMBps: number;
  } {
    return {
      available: true,
      last: this.lastTimings,
      history: this.history,
      approxBandwidthMBps: this.approxBandwidthMBps,
    };
  }

  destroy(): void {
    this.querySet.destroy();
    this.resolveBuffer.destroy();
    this.readbackBuffer.destroy();
  }
}

export function publishGpuTimestampBreadcrumbs(available: boolean, reason?: string): void {
  if (typeof window === 'undefined') return;
  (window as Window & {
    gpuTimestampAvailable?: boolean;
    gpuTimestampReason?: string;
  }).gpuTimestampAvailable = available;
  (window as Window & { gpuTimestampReason?: string }).gpuTimestampReason = available
    ? 'timestamp-query enabled'
    : (reason ?? 'timestamp-query not supported');
}
