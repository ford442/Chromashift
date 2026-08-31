import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildWebGpuCanvasConfiguration,
  buildWebGpuCapabilityReport,
  deriveRequiredLimits,
  getGpuFatalError,
  isFatalGpuDeviceRequestError,
  listAvailableOptionalFeatures,
  logAdapterReport,
  MIN_DEVICE_TEXTURE_DIMENSION,
  releasePageGpuDevice,
  requestWebGpuDevice,
  resetGpuDeviceGateForTests,
  toBootstrapRuntimeError,
  deviceLostRuntimeError,
} from './gpuBootstrap';
import { getWebGL2ContextAttributes, CHROMASHIFT_OPTIONAL_FEATURES, CHROMASHIFT_TARGET_MAX_TEXTURE } from './gpuOptions';

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

function mockAdapter(features: GPUFeatureName[] = []): GPUAdapter {
  return {
    features: new Set(features),
    limits: mockAdapterLimits(),
    requestDevice: async () => { throw new Error('not implemented'); },
  } as unknown as GPUAdapter;
}

describe('deriveRequiredLimits', () => {
  it('requests 8K headroom when requestHeadroom is enabled', () => {
    const limits = mockAdapterLimits({ maxTextureDimension2D: 16384 });
    const required = deriveRequiredLimits(limits, 1920, 1080, { requestHeadroom: true });
    expect(required?.maxTextureDimension2D).toBe(CHROMASHIFT_TARGET_MAX_TEXTURE);
  });

  it('requests only canvas size by default (bootstrap-safe)', () => {
    const limits = mockAdapterLimits({ maxTextureDimension2D: 16384 });
    const required = deriveRequiredLimits(limits, 1920, 1080);
    expect(required?.maxTextureDimension2D).toBe(1920);
  });

  it('floors a collapsed canvas at MIN_DEVICE_TEXTURE_DIMENSION', () => {
    const limits = mockAdapterLimits({ maxTextureDimension2D: 16384 });
    const required = deriveRequiredLimits(limits, 150, 150);
    expect(required?.maxTextureDimension2D).toBe(MIN_DEVICE_TEXTURE_DIMENSION);
  });

  it('never exceeds adapter maxTextureDimension2D', () => {
    const limits = mockAdapterLimits({ maxTextureDimension2D: 4096 });
    const required = deriveRequiredLimits(limits, 7680, 4320, { requestHeadroom: true });
    expect(required?.maxTextureDimension2D).toBe(4096);
  });

  it('covers very large canvases up to adapter cap', () => {
    const limits = mockAdapterLimits({ maxTextureDimension2D: 16384 });
    const required = deriveRequiredLimits(limits, 9000, 5000, { requestHeadroom: true });
    expect(required?.maxTextureDimension2D).toBe(9000);
  });
});

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
    const device = { features: new Set(['timestamp-query']) } as unknown as GPUDevice;
    const adapter = {
      features: new Set(['timestamp-query']),
      limits: mockAdapterLimits(),
      requestDevice: async (descriptor?: GPUDeviceDescriptor) => {
        calls.push(descriptor ?? {});
        return device;
      },
    } as unknown as GPUAdapter;

    await requestWebGpuDevice(adapter, 1920, 1080, undefined, ['timestamp-query']);

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
    const requestDevice = vi.fn(async () => ({ features: new Set() }) as unknown as GPUDevice);
    const adapter = {
      features: new Set(),
      limits: mockAdapterLimits(),
      requestDevice,
    } as unknown as GPUAdapter;

    const first = await requestWebGpuDevice(adapter, 1068, 1068);
    const second = await requestWebGpuDevice(adapter, 150, 150, undefined, ['timestamp-query']);

    expect(second).toBe(first);
    expect(requestDevice).toHaveBeenCalledOnce();
    expect(requestDeviceLogMeta(infoSpy)).toHaveLength(1);

    await Promise.all(Array.from({ length: 48 }, () => requestWebGpuDevice(adapter, 150, 150)));
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

    await expect(requestWebGpuDevice(adapter, 1920, 1080, undefined, ['timestamp-query'])).rejects.toThrow(
      /E_OUTOFMEMORY/,
    );
    expect(calls).toHaveLength(1);
    expect(requestDeviceLogMeta(infoSpy)).toHaveLength(1);
    expect(debugSpy).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0]?.[0]).toBe('[Chromashift:GPU] requestDevice failed');
    expect(String(errorSpy.mock.calls[0]?.[2])).toMatch(/E_OUTOFMEMORY/);
    expect(getGpuFatalError()?.recoverable).toBe(false);

    await expect(requestWebGpuDevice(adapter, 150, 150, undefined, ['timestamp-query'])).rejects.toThrow(
      /out of memory|E_OUTOFMEMORY/i,
    );
    expect(calls).toHaveLength(1);
  });

  it('walks default-limits → canvas-limits → no optional features on non-OOM failure', async () => {
    const calls: GPUDeviceDescriptor[] = [];
    const device = { features: new Set() } as unknown as GPUDevice;
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

    const result = await requestWebGpuDevice(adapter, 1920, 1080, undefined, ['timestamp-query']);

    expect(result).toBe(device);
    expect(calls).toHaveLength(3);
    expect(calls[0]?.requiredFeatures).toEqual(['timestamp-query']);
    expect(calls[0]?.requiredLimits).toBeUndefined();
    expect(calls[1]?.requiredFeatures).toEqual(['timestamp-query']);
    expect(calls[1]?.requiredLimits?.maxTextureDimension2D).toBe(1920);
    expect(Array.from(calls[2]?.requiredFeatures ?? [])).toEqual([]);
    expect(calls[2]?.requiredLimits?.maxTextureDimension2D).toBe(1920);
    expect(requestDeviceLogMeta(infoSpy)).toEqual([
      expect.objectContaining({ attempt: 1, strategy: 'default-limits' }),
    ]);
    expect(requestDeviceLogMeta(debugSpy)).toEqual([
      expect.objectContaining({ attempt: 2, strategy: 'canvas-limits', requiredFeatures: ['timestamp-query'] }),
      expect.objectContaining({ attempt: 3, strategy: 'no-optional-features', requiredFeatures: [] }),
    ]);
    expect(errorSpy).toHaveBeenCalledTimes(2);
  });

  it('propagates the error when the device request fails with no optional features requested', async () => {
    const adapter = {
      features: new Set(),
      limits: mockAdapterLimits(),
      requestDevice: async () => {
        throw new Error('no adapter available');
      },
    } as unknown as GPUAdapter;

    await expect(requestWebGpuDevice(adapter, 1920, 1080, undefined, [])).rejects.toThrow(
      'no adapter available',
    );
    expect(debugSpy).toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledTimes(2);
    expect(getGpuFatalError()?.recoverable).toBe(false);

    await expect(requestWebGpuDevice(adapter, 1920, 1080, undefined, [])).rejects.toThrow(
      'no adapter available',
    );
    expect(errorSpy).toHaveBeenCalledTimes(2);
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

    const first = requestWebGpuDevice(adapter, 1068, 1068);
    const second = requestWebGpuDevice(adapter, 150, 150);
    const device = { features: new Set() } as unknown as GPUDevice;
    resolveDevice?.(device);

    expect(await first).toBe(device);
    expect(await second).toBe(device);
    expect(requestDevice).toHaveBeenCalledOnce();
  });

  it('allows a new acquire after releasePageGpuDevice (device-lost retry)', async () => {
    const requestDevice = vi.fn(async () => ({ features: new Set() }) as unknown as GPUDevice);
    const adapter = {
      features: new Set(),
      limits: mockAdapterLimits(),
      requestDevice,
    } as unknown as GPUAdapter;

    await requestWebGpuDevice(adapter, 1920, 1080);
    releasePageGpuDevice();
    await requestWebGpuDevice(adapter, 1920, 1080);

    expect(requestDevice).toHaveBeenCalledTimes(2);
    expect(requestDeviceLogMeta(infoSpy)).toHaveLength(2);
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

    logAdapterReport(report, { maxTextureDimension2D: 1068 });
    logAdapterReport(report, { maxTextureDimension2D: 150 });

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

describe('buildWebGpuCanvasConfiguration', () => {
  const device = {} as GPUDevice;

  beforeEach(() => {
    vi.stubGlobal('GPUTextureUsage', {
      RENDER_ATTACHMENT: 0x10,
      COPY_SRC: 0x01,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('defaults to opaque sRGB without tone mapping unless requested', () => {
    const config = buildWebGpuCanvasConfiguration(device, 'bgra8unorm');
    expect(config.colorSpace).toBe('srgb');
    expect(config.alphaMode).toBe('opaque');
    expect(config.toneMapping).toBeUndefined();
  });

  it('passes display-p3 through on the configuration object', () => {
    const config = buildWebGpuCanvasConfiguration(device, 'bgra8unorm', {
      colorSpace: 'display-p3',
      toneMappingMode: 'standard',
    });
    expect(config.colorSpace).toBe('display-p3');
    expect(config.toneMapping).toEqual({ mode: 'standard' });
  });
});

describe('getWebGL2ContextAttributes', () => {
  it('maps antialias from renderer options', () => {
    expect(getWebGL2ContextAttributes({ antialias: true }).antialias).toBe(true);
    expect(getWebGL2ContextAttributes({ antialias: false }).antialias).toBe(false);
  });

  it('keeps alpha disabled and preserveDrawingBuffer enabled', () => {
    const attrs = getWebGL2ContextAttributes({ antialias: false });
    expect(attrs.alpha).toBe(false);
    expect(attrs.preserveDrawingBuffer).toBe(true);
  });

  it('allows callers to override preserveDrawingBuffer and xr compatibility', () => {
    const attrs = getWebGL2ContextAttributes({
      antialias: false,
      preserveDrawingBuffer: false,
      xrCompatible: true,
    });
    expect(attrs.preserveDrawingBuffer).toBe(false);
    expect(attrs.xrCompatible).toBe(true);
  });
});

describe('runtime error helpers', () => {
  it('marks queue-create OOM as a non-recoverable bootstrap failure', () => {
    const err = toBootstrapRuntimeError(
      new Error("Failed to execute 'requestDevice' on 'GPUAdapter': D3D12 create command queue failed with E_OUTOFMEMORY (0x8007000E)"),
    );
    expect(err.kind).toBe('bootstrap');
    expect(err.recoverable).toBe(false);
    expect(err.message).toContain('out of memory');
    expect(err.detail).toContain('E_OUTOFMEMORY');
  });

  it('marks other bootstrap failures as non-recoverable', () => {
    const err = toBootstrapRuntimeError(new Error('No adapter'));
    expect(err.kind).toBe('bootstrap');
    expect(err.recoverable).toBe(false);
  });

  it('detects D3D12 queue OOM text', () => {
    expect(isFatalGpuDeviceRequestError(new Error('create command queue failed with E_OUTOFMEMORY'))).toBe(true);
    expect(isFatalGpuDeviceRequestError(new Error('no adapter available'))).toBe(false);
  });

  it('formats device loss with detail', () => {
    const err = deviceLostRuntimeError({ reason: 'unknown', message: 'reset' } as GPUDeviceLostInfo);
    expect(err.kind).toBe('device-lost');
    expect(err.recoverable).toBe(true);
    expect(err.detail).toContain('reset');
  });
});
