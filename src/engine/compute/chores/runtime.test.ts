import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CpuChoreBackend, type CpuChoreHost } from './cpuBackend';
import { createChoresRuntime } from './runtime';
import {
  CHORE_BACKEND_ORDER,
  type ChoreBackendImpl,
  type CoincidenceJob,
  type ImageAnalysisJob,
  type ImageAnalysisOutput,
} from './types';

const IMAGE = {} as HTMLImageElement;
const TEXTURE = {} as GPUTexture;
const LAYERS: readonly [GPUTexture, GPUTexture, GPUTexture] = [TEXTURE, TEXTURE, TEXTURE];

function job(overrides: Partial<ImageAnalysisJob> = {}): ImageAnalysisJob {
  return { op: 'image-analysis', width: 64, height: 64, ...overrides };
}

function coincidenceJob(overrides: Partial<CoincidenceJob> = {}): CoincidenceJob {
  return {
    op: 'coincidence', width: 64, height: 64, colorThresh: 0.05, stampBoost: 1.8, tracerMode: 0,
    ...overrides,
  };
}

/** Minimal stand-in for the WebGPU lane; needs a `source` to accept a job. */
function gpuLane(overrides: Partial<ChoreBackendImpl> = {}): ChoreBackendImpl {
  return {
    backend: 'webgpu',
    canRun: (j) => j.op === 'image-analysis' && Boolean(j.source),
    declineReason: () => 'No GPU-resident source texture',
    run: async () => ({
      kind: 'gpu-texture',
      avgLuminance: 100,
      maskTexture: TEXTURE,
      histogram: new Uint32Array(256),
    }) as ImageAnalysisOutput,
    ...overrides,
  };
}

function cpuHost(overrides: Partial<CpuChoreHost> = {}): CpuChoreHost {
  return {
    isWasmReady: () => true,
    computeImageAverageLuminanceWith: () => 120,
    classifyImageMaskWith: () => ({ mask: new Uint8Array(4), width: 2, height: 2 }),
    ...overrides,
  };
}

describe('gpu-chores runtime', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('declares the canonical fallback order without a WebGL lane', () => {
    expect(CHORE_BACKEND_ORDER).toEqual(['webgpu', 'wasm', 'ts']);
    expect(CHORE_BACKEND_ORDER).not.toContain('webgl');
  });

  it('prefers the webgpu lane when a GPU source is present', async () => {
    const host = cpuHost();
    const classify = vi.spyOn(host, 'classifyImageMaskWith');
    const runtime = createChoresRuntime([
      gpuLane(),
      new CpuChoreBackend('wasm', host),
      new CpuChoreBackend('ts', host),
    ]);

    const result = await runtime.runJob(job({ source: TEXTURE, image: IMAGE }));

    expect(result.ok).toBe(true);
    expect(result.ok && result.backend).toBe('webgpu');
    // CPU lanes must not run when the GPU lane succeeded.
    expect(classify).not.toHaveBeenCalled();
  });

  it('falls through to wasm when the GPU lane declines, recording the reason', async () => {
    const runtime = createChoresRuntime([
      gpuLane(),
      new CpuChoreBackend('wasm', cpuHost()),
      new CpuChoreBackend('ts', cpuHost()),
    ]);

    // No `source` — the GPU lane cannot take the job.
    const result = await runtime.runJob(job({ image: IMAGE }));

    expect(result.ok).toBe(true);
    expect(result.ok && result.backend).toBe('wasm');
  });

  it('falls through to ts when the wasm module is not ready', async () => {
    const runtime = createChoresRuntime([
      gpuLane(),
      new CpuChoreBackend('wasm', cpuHost({ isWasmReady: () => false })),
      new CpuChoreBackend('ts', cpuHost()),
    ]);

    const result = await runtime.runJob(job({ image: IMAGE }));

    expect(result.ok).toBe(true);
    expect(result.ok && result.backend).toBe('ts');
  });

  it('degrades to a CPU lane with a recorded reason when the GPU lane throws', async () => {
    const runtime = createChoresRuntime([
      gpuLane({
        canRun: () => true,
        run: async () => {
          throw new Error('Device lost');
        },
      }),
      new CpuChoreBackend('wasm', cpuHost()),
    ]);

    const result = await runtime.runJob(job({ source: TEXTURE, image: IMAGE }));

    expect(result.ok).toBe(true);
    expect(result.ok && result.backend).toBe('wasm');
  });

  it('never silently skips: a total failure reports every attempt', async () => {
    const runtime = createChoresRuntime([
      gpuLane(),
      new CpuChoreBackend('wasm', cpuHost({ isWasmReady: () => false })),
      new CpuChoreBackend('ts', cpuHost({ classifyImageMaskWith: () => null })),
    ]);

    const result = await runtime.runJob(job({ image: IMAGE }));

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.attempts.map((a) => a.backend)).toEqual(['webgpu', 'wasm', 'ts']);
    expect(result.attempts[0].reason).toContain('No GPU-resident source');
    expect(result.attempts[1].reason).toContain('WASM module not ready');
    expect(result.attempts[2].outcome).toBe('failed');
    expect(result.reason).toContain('ts:');
  });

  it('a pinned lane never slides to another lane', async () => {
    const runtime = createChoresRuntime([
      gpuLane(),
      new CpuChoreBackend('wasm', cpuHost()),
      new CpuChoreBackend('ts', cpuHost()),
    ]);

    // GPU pinned but no source: must fail rather than fall back to wasm.
    const result = await runtime.runJob(job({ image: IMAGE, prefer: 'webgpu' }));

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0].backend).toBe('webgpu');
  });

  it('registers no webgpu lane on a WebGL backend (no device adopted)', async () => {
    const host = cpuHost();
    const runtime = createChoresRuntime([
      new CpuChoreBackend('wasm', host),
      new CpuChoreBackend('ts', host),
    ]);

    expect(runtime.availableBackends()).toEqual(['wasm', 'ts']);

    const result = await runtime.runJob(job({ image: IMAGE }));
    expect(result.ok && result.backend).toBe('wasm');
  });

  it('destroy() tears down every registered lane once', () => {
    const destroy = vi.fn();
    const runtime = createChoresRuntime([gpuLane({ destroy })]);
    runtime.destroy();
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(runtime.availableBackends()).toEqual([]);
  });
});

describe('gpu-chores runtime — coincidence op (GPU-only, no CPU lane)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  /** Minimal stand-in for the WebGPU lane's coincidence support. */
  function coincidenceGpuLane(overrides: Partial<ChoreBackendImpl> = {}): ChoreBackendImpl {
    return {
      backend: 'webgpu',
      canRun: (j) => j.op === 'coincidence' && Boolean(j.layers),
      declineReason: () => 'No GPU-resident layer textures',
      run: async () => ({
        kind: 'gpu-coincidence',
        stampTexture: TEXTURE,
        diagTexture: TEXTURE,
      }),
      ...overrides,
    };
  }

  it('routes a coincidence job to the webgpu lane', async () => {
    const runtime = createChoresRuntime([
      coincidenceGpuLane(),
      new CpuChoreBackend('wasm', cpuHost()),
      new CpuChoreBackend('ts', cpuHost()),
    ]);

    const result = await runtime.runJob(coincidenceJob({ layers: LAYERS }));

    expect(result.ok).toBe(true);
    expect(result.ok && result.backend).toBe('webgpu');
    expect(result.ok && result.value.kind).toBe('gpu-coincidence');
  });

  it('CPU lanes decline coincidence outright — there is no load-time analogue', async () => {
    const runtime = createChoresRuntime([
      new CpuChoreBackend('wasm', cpuHost()),
      new CpuChoreBackend('ts', cpuHost()),
    ]);

    const result = await runtime.runJob(coincidenceJob({ layers: LAYERS }));

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.attempts.map((a) => a.backend)).toEqual(['webgpu', 'wasm', 'ts']);
    expect(result.attempts[0].reason).toContain('not registered');
    expect(result.attempts[1].reason).toContain('GPU compute only');
    expect(result.attempts[2].reason).toContain('GPU compute only');
  });

  it('a coincidence job never falls back to a CPU lane even when GPU declines', async () => {
    const runtime = createChoresRuntime([
      coincidenceGpuLane({ canRun: () => false }),
      new CpuChoreBackend('wasm', cpuHost()),
      new CpuChoreBackend('ts', cpuHost()),
    ]);

    const result = await runtime.runJob(coincidenceJob());

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.attempts.map((a) => a.backend)).toEqual(['webgpu', 'wasm', 'ts']);
    expect(result.attempts[1].reason).toContain('GPU compute only');
    expect(result.attempts[2].reason).toContain('GPU compute only');
  });
});
