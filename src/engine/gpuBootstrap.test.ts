import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildWebGpuCanvasConfiguration,
  buildWebGpuCapabilityReport,
  deriveRequiredLimits,
  listAvailableOptionalFeatures,
  requestWebGpuDevice,
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
  it('requests supported optional features on the first device attempt', async () => {
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

    expect(calls[0]?.requiredFeatures).toEqual(['timestamp-query']);
  });

  it('requests the same features across every limit fallback tier', async () => {
    const calls: GPUDeviceDescriptor[] = [];
    const device = { features: new Set(['timestamp-query']) } as unknown as GPUDevice;
    const adapter = {
      features: new Set(['timestamp-query']),
      limits: mockAdapterLimits(),
      requestDevice: async (descriptor?: GPUDeviceDescriptor) => {
        calls.push(descriptor ?? {});
        if (calls.length < 3) throw new Error('simulated failure');
        return device;
      },
    } as unknown as GPUAdapter;

    await requestWebGpuDevice(adapter, 1920, 1080, undefined, ['timestamp-query']);

    expect(calls).toHaveLength(3);
    expect(calls[0]?.requiredLimits).toBeUndefined();
    expect(calls[1]?.requiredLimits?.maxTextureDimension2D).toBe(1920);
    expect(calls[2]?.requiredLimits?.maxTextureDimension2D).toBe(CHROMASHIFT_TARGET_MAX_TEXTURE);
    for (const call of calls) {
      expect(call.requiredFeatures).toEqual(['timestamp-query']);
    }
  });

  it('degrades gracefully by retrying without optional features when every feature-bearing attempt fails', async () => {
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
    expect(calls.length).toBeGreaterThan(3);
    expect(calls.slice(0, 3).every((c) => Array.from(c.requiredFeatures ?? []).length > 0)).toBe(true);
    expect(Array.from(calls[calls.length - 1]?.requiredFeatures ?? [])).toEqual([]);
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
  it('marks bootstrap failures as recoverable', () => {
    const err = toBootstrapRuntimeError(new Error('No adapter'));
    expect(err.kind).toBe('bootstrap');
    expect(err.recoverable).toBe(true);
  });

  it('formats device loss with detail', () => {
    const err = deviceLostRuntimeError({ reason: 'unknown', message: 'reset' } as GPUDeviceLostInfo);
    expect(err.kind).toBe('device-lost');
    expect(err.recoverable).toBe(true);
    expect(err.detail).toContain('reset');
  });
});
