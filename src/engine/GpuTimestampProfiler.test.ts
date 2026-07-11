import { describe, expect, it } from 'vitest';
import {
  estimatePassBandwidthMBps,
  parseTimestampMarkers,
  GPU_TIMESTAMP_MARKERS,
} from './GpuTimestampProfiler';

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
