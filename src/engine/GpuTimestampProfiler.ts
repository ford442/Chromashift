/** Per-pass GPU timings derived from WebGPU timestamp queries (nanoseconds → ms). */
export interface GpuPassTimings {
  layersMs: number;
  persistenceMs: number;
  compositorMs: number;
  readbackMs: number;
  totalGpuMs: number;
}

export const GPU_TIMESTAMP_MARKERS = 5;
export const GPU_TIMING_HISTORY_SIZE = 120;

const QUERIES_PER_FRAME = GPU_TIMESTAMP_MARKERS;
const BYTES_PER_QUERY = 8;
const RESOLVE_SLOTS = 2;

export interface BandwidthEstimateInput {
  canvasW: number;
  canvasH: number;
  layerScale: number;
  tracerScale: number;
  sampleCount: number;
  readbackActive: boolean;
}

/** Rough read/write traffic model for rgba16float internal targets (8 B/px). */
export function estimatePassBandwidthMBps(
  dims: BandwidthEstimateInput,
  timings: GpuPassTimings,
): number {
  const bytesPerPixel = 8;
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

  const totalBytes = layersBytes + persistBytes + compositorBytes + readbackBytes;
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
    persistenceMs: toMs(stamps[1], stamps[2]),
    compositorMs: toMs(stamps[2], stamps[3]),
    readbackMs: toMs(stamps[3], stamps[4]),
    totalGpuMs: toMs(stamps[0], stamps[4]),
  };
}

/**
 * WebGPU timestamp-query profiler with a two-slot resolve buffer and 120-frame CPU history.
 * When disabled, callers must not invoke marker methods — zero GPU resolve cost.
 */
export class GpuTimestampProfiler {
  private readonly querySet: GPUQuerySet;
  private readonly resolveBuffer: GPUBuffer;
  private readonly timestampPeriodNs: number;
  private enabled = false;
  private writeSlot = 0;
  private pendingSlot: number | null = null;
  private mapPending = false;

  private lastTimings: GpuPassTimings | null = null;
  private readonly history: number[] = [];
  private approxBandwidthMBps = 0;
  private bandwidthInput: BandwidthEstimateInput | null = null;

  static create(device: GPUDevice): GpuTimestampProfiler | null {
    if (!device.features.has('timestamp-query')) return null;
    return new GpuTimestampProfiler(device);
  }

  private constructor(device: GPUDevice) {
    const queue = device.queue as GPUQueue & { getTimestampPeriod?: () => number };
    const limits = device.limits as GPUSupportedLimits & { timestampPeriod?: number };
    this.timestampPeriodNs = typeof queue.getTimestampPeriod === 'function'
      ? queue.getTimestampPeriod()
      : (limits.timestampPeriod ?? 1);
    this.querySet = device.createQuerySet({
      type: 'timestamp',
      count: QUERIES_PER_FRAME,
    });
    this.resolveBuffer = device.createBuffer({
      size: QUERIES_PER_FRAME * BYTES_PER_QUERY * RESOLVE_SLOTS,
      usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.MAP_READ,
    });
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

  markPersistenceEnd(enc: GPUCommandEncoder): void {
    if (!this.enabled) return;
    enc.writeTimestamp(this.querySet, 2);
  }

  markCompositorEnd(enc: GPUCommandEncoder): void {
    if (!this.enabled) return;
    enc.writeTimestamp(this.querySet, 3);
  }

  finishFrame(enc: GPUCommandEncoder): void {
    if (!this.enabled) return;
    enc.writeTimestamp(this.querySet, 4);
    const slot = this.writeSlot;
    enc.resolveQuerySet(
      this.querySet,
      0,
      QUERIES_PER_FRAME,
      this.resolveBuffer,
      slot * QUERIES_PER_FRAME * BYTES_PER_QUERY,
    );
    this.pendingSlot = slot;
    this.writeSlot = (this.writeSlot + 1) % RESOLVE_SLOTS;
  }

  afterSubmit(): void {
    if (!this.enabled || this.pendingSlot === null || this.mapPending) return;
    const slot = this.pendingSlot;
    this.pendingSlot = null;
    this.mapPending = true;
    const offset = slot * QUERIES_PER_FRAME * BYTES_PER_QUERY;
    const byteLength = QUERIES_PER_FRAME * BYTES_PER_QUERY;

    void this.resolveBuffer.mapAsync(GPUMapMode.READ, offset, byteLength).then(() => {
      const stamps = new BigUint64Array(
        this.resolveBuffer.getMappedRange(offset, byteLength),
      );
      const timings = parseTimestampMarkers(stamps, this.timestampPeriodNs);
      this.resolveBuffer.unmap();
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
