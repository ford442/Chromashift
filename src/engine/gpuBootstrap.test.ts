import { describe, expect, it } from 'vitest';
import {
  deriveRequiredLimits,
  listAvailableOptionalFeatures,
  toBootstrapRuntimeError,
  deviceLostRuntimeError,
} from './gpuBootstrap';
import { getWebGL2ContextAttributes, CHROMASHIFT_TARGET_MAX_TEXTURE } from './gpuOptions';

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
    const adapter = mockAdapter(['timestamp-query', 'float32-filterable']);
    expect(listAvailableOptionalFeatures(adapter)).toEqual([
      'timestamp-query',
      'float32-filterable',
    ]);
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
