import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  estimatePassBandwidthMBps,
  GpuTimestampProfiler,
  parseTimestampMarkers,
  GPU_TIMESTAMP_MARKERS,
} from './GpuTimestampProfiler';

const MAP_READ = 0x0001;
const COPY_SRC = 0x0004;
const COPY_DST = 0x0008;
const QUERY_RESOLVE = 0x0200;

function installBufferUsageGlobals(): void {
  vi.stubGlobal('GPUBufferUsage', {
    MAP_READ,
    COPY_SRC,
    COPY_DST,
    QUERY_RESOLVE,
  });
  vi.stubGlobal('GPUMapMode', { READ: MAP_READ });
}

function mockTimestampDevice(options?: {
  features?: Iterable<GPUFeatureName>;
  timestampPeriod?: number;
  createBuffer?: (desc: GPUBufferDescriptor) => GPUBuffer;
}): GPUDevice {
  const createBuffer = options?.createBuffer ?? ((desc: GPUBufferDescriptor) => {
    const usage = Number(desc.usage);
    if ((usage & MAP_READ) !== 0 && (usage & ~(MAP_READ | COPY_DST)) !== 0) {
      throw new Error(
        'Buffer usages (MapRead|CopySrc|QueryResolve) is invalid. '
        + 'If a buffer usage contains BufferUsage::MapRead the only other allowed usage is BufferUsage::CopyDst.',
      );
    }
    return { destroy: vi.fn() } as unknown as GPUBuffer;
  });

  return {
    features: new Set(options?.features ?? ['timestamp-query']),
    limits: { timestampPeriod: options?.timestampPeriod ?? 1 },
    queue: {},
    createQuerySet: vi.fn(() => ({ destroy: vi.fn() })),
    createBuffer: vi.fn(createBuffer),
  } as unknown as GPUDevice;
}

describe('parseTimestampMarkers', () => {
  it('converts nanosecond deltas to milliseconds', () => {
    const periodNs = 1;
    const stamps = new BigUint64Array(GPU_TIMESTAMP_MARKERS);
    stamps[0] = 0n;
    stamps[1] = 1_000_000n;
    stamps[2] = 2_500_000n;
    stamps[3] = 4_000_000n;
    stamps[4] = 4_500_000n;

    const timings = parseTimestampMarkers(stamps, periodNs);
    expect(timings.layersMs).toBeCloseTo(1);
    expect(timings.persistenceMs).toBeCloseTo(1.5);
    expect(timings.compositorMs).toBeCloseTo(1.5);
    expect(timings.readbackMs).toBeCloseTo(0.5);
    expect(timings.totalGpuMs).toBeCloseTo(4.5);
  });
});

describe('estimatePassBandwidthMBps', () => {
  it('returns a positive rate for typical 1080p dimensions', () => {
    const rate = estimatePassBandwidthMBps(
      {
        canvasW: 1920,
        canvasH: 1080,
        layerScale: 1,
        tracerScale: 1,
        sampleCount: 4,
        readbackActive: true,
      },
      {
        layersMs: 2,
        persistenceMs: 1,
        compositorMs: 1,
        readbackMs: 0.5,
        totalGpuMs: 4.5,
      },
    );
    expect(rate).toBeGreaterThan(0);
  });

  it('drops readback traffic when live readback is off', () => {
    const withReadback = estimatePassBandwidthMBps(
      {
        canvasW: 512,
        canvasH: 512,
        layerScale: 1,
        tracerScale: 1,
        sampleCount: 1,
        readbackActive: true,
      },
      { layersMs: 1, persistenceMs: 1, compositorMs: 1, readbackMs: 0, totalGpuMs: 3 },
    );
    const withoutReadback = estimatePassBandwidthMBps(
      {
        canvasW: 512,
        canvasH: 512,
        layerScale: 1,
        tracerScale: 1,
        sampleCount: 1,
        readbackActive: false,
      },
      { layersMs: 1, persistenceMs: 1, compositorMs: 1, readbackMs: 0, totalGpuMs: 3 },
    );
    expect(withReadback).toBeGreaterThan(withoutReadback);
  });
});

describe('GpuTimestampProfiler.create', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('returns null when timestamp-query is not granted', () => {
    installBufferUsageGlobals();
    const result = GpuTimestampProfiler.create(mockTimestampDevice({ features: [] }));
    expect(result.profiler).toBeNull();
    expect(result.reason).toBe('timestamp-query not granted');
  });

  it('skips GPU timing when the timestamp period is 0', () => {
    installBufferUsageGlobals();
    const result = GpuTimestampProfiler.create(mockTimestampDevice({ timestampPeriod: 0 }));
    expect(result.profiler).toBeNull();
    expect(result.reason).toMatch(/timestamp period is 0/i);
  });

  it('allocates a resolve buffer and a MAP_READ|COPY_DST readback', () => {
    installBufferUsageGlobals();
    const device = mockTimestampDevice();
    const result = GpuTimestampProfiler.create(device);
    expect(result.profiler).not.toBeNull();
    expect(result.reason).toBeUndefined();

    const createBuffer = device.createBuffer as ReturnType<typeof vi.fn>;
    const usages = createBuffer.mock.calls.map((call) => Number(call[0].usage));
    expect(usages).toContain(QUERY_RESOLVE | COPY_SRC);
    expect(usages).toContain(MAP_READ | COPY_DST);
    expect(usages.some((usage) => (usage & MAP_READ) !== 0 && (usage & QUERY_RESOLVE) !== 0)).toBe(false);
    result.profiler?.destroy();
  });

  it('does not throw when createBuffer rejects the illegal usage mix', () => {
    installBufferUsageGlobals();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const device = mockTimestampDevice({
      createBuffer: () => {
        throw new Error(
          'If a buffer usage contains BufferUsage::MapRead the only other allowed usage is BufferUsage::CopyDst.',
        );
      },
    });
    const result = GpuTimestampProfiler.create(device);
    expect(result.profiler).toBeNull();
    expect(result.reason).toMatch(/buffers unavailable/i);
    expect(warn).toHaveBeenCalled();
  });

  it('copies resolved timestamps into the readback buffer', () => {
    installBufferUsageGlobals();
    const device = mockTimestampDevice();
    const { profiler } = GpuTimestampProfiler.create(device);
    expect(profiler).not.toBeNull();
    profiler!.setEnabled(true);

    const enc = {
      writeTimestamp: vi.fn(),
      resolveQuerySet: vi.fn(),
      copyBufferToBuffer: vi.fn(),
    };
    profiler!.finishFrame(enc as unknown as GPUCommandEncoder);

    expect(enc.resolveQuerySet).toHaveBeenCalledTimes(1);
    expect(enc.copyBufferToBuffer).toHaveBeenCalledTimes(1);
    const copy = enc.copyBufferToBuffer.mock.calls[0];
    const resolveBuf = (device.createBuffer as ReturnType<typeof vi.fn>).mock.results[0]?.value;
    const readbackBuf = (device.createBuffer as ReturnType<typeof vi.fn>).mock.results[1]?.value;
    expect(copy[0]).toBe(resolveBuf);
    expect(copy[2]).toBe(readbackBuf);
    expect(copy[4]).toBe(GPU_TIMESTAMP_MARKERS * 8);
    profiler!.destroy();
  });
});
