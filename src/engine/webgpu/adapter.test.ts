import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getGpuFatalError } from '../gpu/gpuErrors';
import {
  buildWebGpuCapabilityReport,
  listAvailableOptionalFeatures,
  logAdapterReport,
  releasePageGpuDevice,
  requestWebGpuAdapter,
  requestWebGpuDevice,
  resetGpuDeviceGateForTests,
} from './adapter';
import { CHROMASHIFT_OPTIONAL_FEATURES } from '../gpu/gpuOptions';

function mockAdapterLimits(overrides: Partial<GPUAdapter['limits']> = {}): GPUAdapter['limits'] {
  return {
    maxTextureDimension1D: 16384,
    maxTextureDimension2D: 16384,
    maxTextureDimension3D: 2048,
    maxTextureArrayLayers: 2048,
    maxBindGroups: 4,
    maxBindGroupsPlusVertexBuffers: 24,
    maxBindingsPerBindGroup: 1000,
    maxDynamicUniformBuffersPerPipelineLayout: 10,
    maxDynamicStorageBuffersPerPipelineLayout: 8,
    maxSampledTexturesPerShaderStage: 16,
    maxSamplersPerShaderStage: 16,
    maxStorageBuffersPerShaderStage: 10,
    maxStorageTexturesPerShaderStage: 8,
    maxUniformBuffersPerShaderStage: 12,
    maxUniformBufferBindingSize: 65536,
    maxStorageBufferBindingSize: 2147483644,
    maxVertexBuffers: 8,
    maxBufferSize: 2147483648,
    maxVertexAttributes: 30,
    maxVertexBufferArrayStride: 2048,
    maxInterStageShaderVariables: 28,
    maxColorAttachments: 8,
    maxColorAttachmentBytesPerSample: 128,
    maxComputeWorkgroupStorageSize: 32768,
    maxComputeInvocationsPerWorkgroup: 1024,
    maxComputeWorkgroupSizeX: 1024,
    maxComputeWorkgroupSizeY: 1024,
    maxComputeWorkgroupSizeZ: 64,
    maxComputeWorkgroupsPerDimension: 65535,
    minUniformBufferOffsetAlignment: 256,
    minStorageBufferOffsetAlignment: 256,
    maxImmediateSize: 128,
    ...overrides,
  } as GPUAdapter['limits'];
}

/** A device that is never lost unless the test resolves `lose`. */
function liveDevice(features: string[] = []): GPUDevice & { lose: (info: GPUDeviceLostInfo) => void } {
  let lose!: (info: GPUDeviceLostInfo) => void;
  const lost = new Promise<GPUDeviceLostInfo>((resolve) => { lose = resolve; });
  return { features: new Set(features), lost, lose } as unknown as GPUDevice & {
    lose: (info: GPUDeviceLostInfo) => void;
  };
}

function mockAdapter(features: GPUFeatureName[] = []): GPUAdapter {
  return {
    features: new Set(features),
    limits: mockAdapterLimits(),
    requestDevice: async () => { throw new Error('not implemented'); },
  } as unknown as GPUAdapter;
}

describe('listAvailableOptionalFeatures', () => {
  it('returns only features supported by the adapter', () => {
    const adapter = mockAdapter(['timestamp-query']);
    expect(listAvailableOptionalFeatures(adapter)).toEqual(['timestamp-query']);
  });

  it('lists multiple optional features when the adapter supports them', () => {
    const adapter = mockAdapter(['timestamp-query', 'rg11b10ufloat-renderable']);
    expect(listAvailableOptionalFeatures(adapter)).toEqual([
      'timestamp-query',
      'rg11b10ufloat-renderable',
    ]);
  });

  it('only requests features that have a live consumer', () => {
    expect([...CHROMASHIFT_OPTIONAL_FEATURES]).toEqual([
      'timestamp-query',
      'rg11b10ufloat-renderable',
      'texture-formats-tier1',
    ]);
  });
});

describe('requestWebGpuDevice', () => {
  let infoSpy: ReturnType<typeof vi.spyOn>;
  let debugSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    resetGpuDeviceGateForTests();
    infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    infoSpy.mockRestore();
    debugSpy.mockRestore();
    errorSpy.mockRestore();
    resetGpuDeviceGateForTests();
  });

  function requestDeviceLogMeta(spy: ReturnType<typeof vi.spyOn>) {
    return spy.mock.calls
      .filter((args) => args[0] === '[Chromashift:GPU] requestDevice')
      .map((args) => args[1] as { attempt: number; strategy: string; requiredFeatures: GPUFeatureName[] });
  }

  it('requests adapter-default limits and supported optional features on the first attempt', async () => {
    const calls: GPUDeviceDescriptor[] = [];
    const device = liveDevice(['timestamp-query']);
    const adapter = {
      features: new Set(['timestamp-query']),
      limits: mockAdapterLimits(),
      requestDevice: async (descriptor?: GPUDeviceDescriptor) => {
        calls.push(descriptor ?? {});
        return device;
      },
    } as unknown as GPUAdapter;

    await requestWebGpuDevice(adapter, ['timestamp-query']);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.requiredFeatures).toEqual(['timestamp-query']);
    expect(calls[0]?.requiredLimits).toBeUndefined();
    expect(requestDeviceLogMeta(infoSpy)).toEqual([
      expect.objectContaining({ attempt: 1, strategy: 'default-limits', requiredFeatures: ['timestamp-query'] }),
    ]);
    expect(debugSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('reuses the live device and does not call requestDevice again', async () => {
    const requestDevice = vi.fn(async () => liveDevice());
    const adapter = {
      features: new Set(),
      limits: mockAdapterLimits(),
      requestDevice,
    } as unknown as GPUAdapter;

    const first = await requestWebGpuDevice(adapter);
    const second = await requestWebGpuDevice(adapter, ['timestamp-query']);

    expect(second).toBe(first);
    expect(requestDevice).toHaveBeenCalledOnce();
    expect(requestDeviceLogMeta(infoSpy)).toHaveLength(1);

    await Promise.all(Array.from({ length: 48 }, () => requestWebGpuDevice(adapter)));
    expect(requestDevice).toHaveBeenCalledOnce();
    expect(requestDeviceLogMeta(infoSpy)).toHaveLength(1);
  });

  it('does not retry after a queue-create OOM', async () => {
    const calls: GPUDeviceDescriptor[] = [];
    const adapter = {
      features: new Set(['timestamp-query']),
      limits: mockAdapterLimits(),
      requestDevice: async (descriptor?: GPUDeviceDescriptor) => {
        calls.push(descriptor ?? {});
        throw new Error("Failed to execute 'requestDevice': D3D12 create command queue failed with E_OUTOFMEMORY (0x8007000E)");
      },
    } as unknown as GPUAdapter;

    await expect(requestWebGpuDevice(adapter, ['timestamp-query'])).rejects.toThrow(
      /E_OUTOFMEMORY/,
    );
    expect(calls).toHaveLength(1);
    expect(requestDeviceLogMeta(infoSpy)).toHaveLength(1);
    expect(debugSpy).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0]?.[0]).toBe('[Chromashift:GPU] requestDevice failed');
    expect(String(errorSpy.mock.calls[0]?.[2])).toMatch(/E_OUTOFMEMORY/);
    expect(getGpuFatalError()?.recoverable).toBe(false);

    await expect(requestWebGpuDevice(adapter, ['timestamp-query'])).rejects.toThrow(
      /out of memory|E_OUTOFMEMORY/i,
    );
    expect(calls).toHaveLength(1);
  });

  it('walks default-limits → no optional features on non-OOM failure, never raising a limit', async () => {
    const calls: GPUDeviceDescriptor[] = [];
    const device = liveDevice();
    const adapter = {
      features: new Set(['timestamp-query']),
      limits: mockAdapterLimits(),
      requestDevice: async (descriptor?: GPUDeviceDescriptor) => {
        calls.push(descriptor ?? {});
        if (Array.from(descriptor?.requiredFeatures ?? []).length > 0) {
          throw new Error('simulated driver quirk rejecting requiredFeatures');
        }
        return device;
      },
    } as unknown as GPUAdapter;

    const result = await requestWebGpuDevice(adapter, ['timestamp-query']);

    expect(result).toBe(device);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.requiredFeatures).toEqual(['timestamp-query']);
    expect(Array.from(calls[1]?.requiredFeatures ?? [])).toEqual([]);
    // A retry that asks for as much or more than the request that just
    // failed cannot succeed (the old `canvas-limits` strategy raised
    // maxColorAttachmentBytesPerSample to the adapter maximum).
    for (const call of calls) expect(call.requiredLimits).toBeUndefined();
    expect(requestDeviceLogMeta(infoSpy)).toEqual([
      expect.objectContaining({ attempt: 1, strategy: 'default-limits' }),
    ]);
    expect(requestDeviceLogMeta(debugSpy)).toEqual([
      expect.objectContaining({ attempt: 2, strategy: 'no-optional-features', requiredFeatures: [] }),
    ]);
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it('propagates the error when the device request fails with no optional features requested', async () => {
    const adapter = {
      features: new Set(),
      limits: mockAdapterLimits(),
      requestDevice: async () => {
        throw new Error('no adapter available');
      },
    } as unknown as GPUAdapter;

    await expect(requestWebGpuDevice(adapter, [])).rejects.toThrow(
      'no adapter available',
    );
    expect(debugSpy).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(getGpuFatalError()?.recoverable).toBe(false);

    await expect(requestWebGpuDevice(adapter, [])).rejects.toThrow(
      'no adapter available',
    );
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it('joins an in-flight acquire instead of starting a second requestDevice', async () => {
    let resolveDevice: ((device: GPUDevice) => void) | undefined;
    const requestDevice = vi.fn(() => new Promise<GPUDevice>((resolve) => {
      resolveDevice = resolve;
    }));
    const adapter = {
      features: new Set(),
      limits: mockAdapterLimits(),
      requestDevice,
    } as unknown as GPUAdapter;

    const first = requestWebGpuDevice(adapter);
    const second = requestWebGpuDevice(adapter);
    const device = liveDevice();
    resolveDevice?.(device);

    expect(await first).toBe(device);
    expect(await second).toBe(device);
    expect(requestDevice).toHaveBeenCalledOnce();
  });

  it('allows a new acquire after releasePageGpuDevice (device-lost retry)', async () => {
    const requestDevice = vi.fn(async () => liveDevice());
    const adapter = {
      features: new Set(),
      limits: mockAdapterLimits(),
      requestDevice,
    } as unknown as GPUAdapter;

    await requestWebGpuDevice(adapter);
    releasePageGpuDevice();
    await requestWebGpuDevice(adapter);

    expect(requestDevice).toHaveBeenCalledTimes(2);
    expect(requestDeviceLogMeta(infoSpy)).toHaveLength(2);
  });

  it('releases the lease itself when the device is lost', async () => {
    const devices = [liveDevice(), liveDevice()];
    const adapter = {
      features: new Set(),
      limits: mockAdapterLimits(),
      requestDevice: vi.fn(async () => devices.shift()!),
    } as unknown as GPUAdapter;

    const first = await requestWebGpuDevice(adapter) as ReturnType<typeof liveDevice>;
    first.lose({ reason: 'unknown', message: 'driver reset' } as GPUDeviceLostInfo);
    await Promise.resolve();

    expect(await requestWebGpuDevice(adapter)).not.toBe(first);
  });
});

describe('Retry GPU after a device loss', () => {
  const originalGpu = (navigator as { gpu?: GPU }).gpu;

  beforeEach(() => {
    resetGpuDeviceGateForTests();
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    Object.defineProperty(navigator, 'gpu', { value: originalGpu, configurable: true });
    resetGpuDeviceGateForTests();
    vi.restoreAllMocks();
  });

  /** An adapter that hands out one device, then refuses — a consumed adapter. */
  function singleUseAdapter(): GPUAdapter {
    let used = false;
    return {
      features: new Set(['timestamp-query']),
      limits: mockAdapterLimits(),
      requestDevice: vi.fn(async () => {
        if (used) throw new DOMException('The adapter has been consumed.', 'OperationError');
        used = true;
        return liveDevice();
      }),
    } as unknown as GPUAdapter;
  }

  it('acquires a fresh adapter, so the new device request can succeed', async () => {
    const requestAdapter = vi.fn(async () => singleUseAdapter());
    Object.defineProperty(navigator, 'gpu', { value: { requestAdapter }, configurable: true });

    const firstAdapter = (await requestWebGpuAdapter())!;
    const lostDevice = await requestWebGpuDevice(firstAdapter, ['timestamp-query']) as ReturnType<typeof liveDevice>;
    lostDevice.lose({ reason: 'unknown', message: 'simulated loss' } as GPUDeviceLostInfo);
    await Promise.resolve();

    // Retry GPU: release, then bootstrap again.
    releasePageGpuDevice();
    const secondAdapter = (await requestWebGpuAdapter())!;
    expect(secondAdapter).not.toBe(firstAdapter);
    await expect(requestWebGpuDevice(secondAdapter, ['timestamp-query'])).resolves.toBeDefined();
    expect(getGpuFatalError()).toBeNull();
  });
});

describe('logAdapterReport', () => {
  afterEach(() => {
    resetGpuDeviceGateForTests();
    vi.restoreAllMocks();
  });

  it('logs Adapter ready once per page', () => {
    resetGpuDeviceGateForTests();
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    const report = {
      vendor: 'nvidia',
      architecture: 'gcn',
      device: 'pascal',
      description: 'GTX 1080',
      features: ['timestamp-query'],
      limits: {
        maxTextureDimension2D: 16384,
        maxBufferSize: 2147483648,
        maxColorAttachmentBytesPerSample: 128,
      },
    };

    logAdapterReport(report);
    logAdapterReport(report);

    expect(infoSpy).toHaveBeenCalledTimes(1);
    expect(infoSpy.mock.calls[0]?.[0]).toBe('[Chromashift:GPU] Adapter ready');
  });
});

describe('buildWebGpuCapabilityReport', () => {
  it('reports granted and missing optional features', () => {
    const adapter = mockAdapter(['timestamp-query', 'rg11b10ufloat-renderable']);
    const device = {
      features: new Set(['rg11b10ufloat-renderable']),
    } as unknown as GPUDevice;

    const report = buildWebGpuCapabilityReport(adapter, device, [
      'timestamp-query',
      'rg11b10ufloat-renderable',
    ]);

    expect(report.adapterOptionalFeatures).toEqual(['timestamp-query', 'rg11b10ufloat-renderable']);
    expect(report.grantedOptionalFeatures).toEqual(['rg11b10ufloat-renderable']);
    expect(report.missingRequestedFeatures).toEqual(['timestamp-query']);
    expect(report.timestampQueryAvailable).toBe(false);
  });

  it('reports no missing features when the device granted every requested optional feature', () => {
    const requested = ['timestamp-query', 'rg11b10ufloat-renderable'] as const;
    const adapter = mockAdapter([...requested]);
    const device = { features: new Set(requested) } as unknown as GPUDevice;
    const report = buildWebGpuCapabilityReport(adapter, device, requested);
    expect(report.missingRequestedFeatures).toEqual([]);
    expect(report.grantedOptionalFeatures).toEqual([...requested]);
    expect(report.timestampQueryAvailable).toBe(true);
  });

  it('reports no missing features for CHROMASHIFT_OPTIONAL_FEATURES when the device grants them all', () => {
    const requested = [...CHROMASHIFT_OPTIONAL_FEATURES];
    const adapter = mockAdapter(requested);
    const device = { features: new Set(requested) } as unknown as GPUDevice;
    const report = buildWebGpuCapabilityReport(adapter, device, requested);
    expect(report.missingRequestedFeatures).toEqual([]);
    expect(report.requestedOptionalFeatures).toEqual(requested);
  });
});
