import { describe, expect, it } from 'vitest';
import type { ImageAnalysisJob } from './types';
import { WebGpuChoreBackend } from './webgpuBackend';

/**
 * A device whose every factory throws: the lane must decide it cannot run
 * *before* touching the device, because on a device without r8uint storage
 * nothing it would create is valid — and invalid WebGPU objects are not
 * exceptions, so "try it and catch" is not a fallback that exists.
 */
function fakeDevice(features: string[]): GPUDevice {
  const refuse = () => {
    throw new Error('the lane touched the device');
  };
  return {
    limits: { maxTextureDimension2D: 8192 },
    features: new Set(features),
    createTexture: refuse,
    createBuffer: refuse,
    createBindGroupLayout: refuse,
    createComputePipeline: refuse,
    createShaderModule: refuse,
    createCommandEncoder: refuse,
  } as unknown as GPUDevice;
}

const source = { width: 64, height: 64, format: 'rgba8unorm' } as unknown as GPUTexture;
const job: ImageAnalysisJob = { op: 'image-analysis', source, width: 64, height: 64 };

describe('WebGpuChoreBackend image analysis', () => {
  it('declines without texture-formats-tier1 and says why', () => {
    const backend = new WebGpuChoreBackend(fakeDevice([]));
    expect(backend.canRun(job)).toBe(false);
    expect(backend.declineReason(job)).toMatch(/texture-formats-tier1/);
  });

  it('returns no result from a direct analyze() call rather than an invalid mask texture', async () => {
    const backend = new WebGpuChoreBackend(fakeDevice([]));
    await expect(backend.analyze(source, 64, 64)).resolves.toBeNull();
  });

  it('accepts the job once the device was granted texture-formats-tier1', () => {
    const backend = new WebGpuChoreBackend(fakeDevice(['texture-formats-tier1']));
    expect(backend.canRun(job)).toBe(true);
  });
});
