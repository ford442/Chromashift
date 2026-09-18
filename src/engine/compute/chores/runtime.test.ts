import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CpuChoreBackend, type CpuChoreHost } from './cpuBackend';
import { createChoresRuntime } from './runtime';
import {
  CHORE_BACKEND_ORDER,
  type ChoreBackendImpl,
  type CoincidenceJob,
  type ImageAnalysisJob,
  type ImageAnalysisOutput,
  type MotionFieldJob,
  type MotionFramePixels,
} from './types';

const IMAGE = {} as HTMLImageElement;
const TEXTURE = {} as GPUTexture;
const LAYERS: readonly GPUTexture[] = [TEXTURE, TEXTURE, TEXTURE];

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
    analyzeImage: async (_image, avgLumHint) => ({
      avgLuminance: avgLumHint ?? 120,
      mask: new Uint8Array(4),
      width: 2,
      height: 2,
      mode: 'inline',
    }),
    computeAverageLuminance: async () => ({ avgLuminance: 120, mode: 'inline' }),
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
    const classify = vi.spyOn(host, 'analyzeImage');
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
      new CpuChoreBackend('ts', cpuHost({ analyzeImage: async () => null })),
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

  it("breadcrumbLabel distinguishes the worker-backed CPU lane from the in-process one", async () => {
    const workerBackedHost = cpuHost({
      analyzeImage: async (_image, avgLumHint) => ({
        avgLuminance: avgLumHint ?? 120,
        mask: new Uint8Array(4),
        width: 2,
        height: 2,
        mode: 'worker',
      }),
    });
    const backend = new CpuChoreBackend('wasm', workerBackedHost);
    // Before any successful run, breadcrumbLabel falls back to the plain lane name.
    expect(backend.breadcrumbLabel!()).toBe('wasm');

    const runtime = createChoresRuntime([backend]);
    await runtime.runJob(job({ image: IMAGE }));
    expect(backend.breadcrumbLabel!()).toBe('wasm-worker');
  });

  it('publishes the wasm-worker/ts-inline breadcrumb label, not the plain backend name, to window.gpuChoreBackend', async () => {
    const fakeWindow = {} as unknown as Window;
    vi.stubGlobal('window', fakeWindow);
    try {
      const inlineHost = cpuHost({
        analyzeImage: async () => ({
          avgLuminance: 90, mask: new Uint8Array(4), width: 2, height: 2, mode: 'inline',
        }),
      });
      const runtime = createChoresRuntime([new CpuChoreBackend('ts', inlineHost)]);
      await runtime.runJob(job({ image: IMAGE }));
      expect((fakeWindow as unknown as { gpuChoreBackend?: string }).gpuChoreBackend).toBe('ts-inline');
    } finally {
      vi.unstubAllGlobals();
    }
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

describe('gpu-chores runtime — motion-field op', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  /** Solid-grey RGBA frame, 4x4, at `level`. */
  function frame(level: number): MotionFramePixels {
    const data = new Uint8ClampedArray(4 * 4 * 4);
    for (let i = 0; i < 16; i += 1) {
      data[i * 4] = level;
      data[i * 4 + 1] = level;
      data[i * 4 + 2] = level;
      data[i * 4 + 3] = 255;
    }
    return { data, width: 4, height: 4 };
  }

  function motionJob(overrides: Partial<MotionFieldJob> = {}): MotionFieldJob {
    return { op: 'motion-field', width: 4, height: 4, threshold: 0.04, divisor: 2, ...overrides };
  }

  /** Minimal stand-in for the WebGPU lane's motion support. */
  function motionGpuLane(overrides: Partial<ChoreBackendImpl> = {}): ChoreBackendImpl {
    return {
      backend: 'webgpu',
      canRun: (j) => j.op === 'motion-field' && Boolean(j.source),
      declineReason: () => 'No GPU-resident source frame',
      run: async () => ({
        kind: 'gpu-motion-field',
        fieldTexture: TEXTURE,
        width: 2,
        height: 2,
        hasFlow: false,
      }),
      ...overrides,
    };
  }

  it('prefers the webgpu lane when a GPU frame is present', async () => {
    const runtime = createChoresRuntime([
      motionGpuLane(),
      new CpuChoreBackend('wasm', cpuHost()),
      new CpuChoreBackend('ts', cpuHost()),
    ]);

    const result = await runtime.runJob(motionJob({ source: TEXTURE, pixels: frame(10) }));

    expect(result.ok).toBe(true);
    expect(result.ok && result.backend).toBe('webgpu');
    expect(result.ok && result.value.kind).toBe('gpu-motion-field');
  });

  it('falls through to ts when the host supplies no WASM motion kernel', async () => {
    const runtime = createChoresRuntime([
      motionGpuLane(),
      new CpuChoreBackend('wasm', cpuHost()),
      new CpuChoreBackend('ts', cpuHost()),
    ]);

    // No GPU source, and the default host has no `motionField` — the WASM
    // lane must decline with a reason rather than pretend.
    const result = await runtime.runJob(motionJob({ pixels: frame(10) }));

    expect(result.ok).toBe(true);
    expect(result.ok && result.backend).toBe('ts');
    expect(result.ok && result.value.kind).toBe('cpu-motion-field');
  });

  it('uses the wasm lane when the host does supply the kernel', async () => {
    const motionField = vi.fn(async () => ({
      field: new Float32Array([0, 0.5, 0, 0]),
      width: 2,
      height: 2,
    }));
    const runtime = createChoresRuntime([
      new CpuChoreBackend('wasm', cpuHost({ motionField })),
      new CpuChoreBackend('ts', cpuHost()),
    ]);

    const result = await runtime.runJob(motionJob({ pixels: frame(10) }));

    expect(result.ok && result.backend).toBe('wasm');
    expect(motionField).toHaveBeenCalledTimes(1);
    expect(result.ok && result.value.kind === 'cpu-motion-field' && result.value.stats.movingFraction)
      .toBeCloseTo(0.25, 5);
  });

  it('leaves the flow vector unsolved unless the job asks for it', async () => {
    // `boost` and `gate` read magnitude alone, so they must not pay for the
    // Lucas-Kanade pyramid behind `direction`.
    const runtime = createChoresRuntime([new CpuChoreBackend('ts', cpuHost())]);

    const without = await runtime.runJob(motionJob({ pixels: frame(10) }));
    const with_ = await runtime.runJob(motionJob({ pixels: frame(200), flow: true }));

    expect(without.ok && without.value.kind === 'cpu-motion-field' && without.value.flow).toBeNull();
    if (!with_.ok || with_.value.kind !== 'cpu-motion-field') throw new Error('expected a CPU field');
    expect(with_.value.flow).not.toBeNull();
    // Two floats per cell of the 2x2 field.
    expect(with_.value.flow!.length).toBe(8);
  });

  it('threads the flow request and the lane\u2019s kernel choice to the host', async () => {
    const motionField: CpuChoreHost['motionField'] = vi.fn(async () => ({
      field: new Float32Array([0, 0.5, 0, 0]),
      flow: new Float32Array(8),
      width: 2,
      height: 2,
      mode: 'worker' as const,
    }));
    const runtime = createChoresRuntime([
      new CpuChoreBackend('wasm', cpuHost({ motionField })),
      new CpuChoreBackend('ts', cpuHost()),
    ]);

    const result = await runtime.runJob(motionJob({ pixels: frame(10), flow: true }));

    expect(result.ok && result.backend).toBe('wasm');
    // (frame, divisor, threshold, reset, flow, useWasm)
    expect(motionField).toHaveBeenCalledWith(
      expect.anything(), 2, 0.04, false, true, true,
    );
    // A worker-served job still reports its lane; only the label says where.
    expect(result.ok && result.value.kind === 'cpu-motion-field' && result.value.flow).not.toBeNull();
  });

  it('returns a small array from the CPU lane, never a full-resolution readback', async () => {
    const runtime = createChoresRuntime([new CpuChoreBackend('ts', cpuHost())]);

    const result = await runtime.runJob(motionJob({ pixels: frame(10) }));

    expect(result.ok).toBe(true);
    if (!result.ok || result.value.kind !== 'cpu-motion-field') throw new Error('expected a CPU field');
    // 4x4 source at divisor 2 -> a 2x2 field, not 16 entries.
    expect(result.value.width).toBe(2);
    expect(result.value.height).toBe(2);
    expect(result.value.field.length).toBe(4);
  });

  it('holds the frame history in the lane: still frames stay at zero, a change does not', async () => {
    const lane = new CpuChoreBackend('ts', cpuHost());
    const runtime = createChoresRuntime([lane]);

    const first = await runtime.runJob(motionJob({ pixels: frame(10) }));
    const still = await runtime.runJob(motionJob({ pixels: frame(10) }));
    const moved = await runtime.runJob(motionJob({ pixels: frame(200) }));

    // First frame has no history to difference against.
    expect(first.ok && first.value.kind === 'cpu-motion-field' && first.value.stats.meanMagnitude).toBe(0);
    expect(still.ok && still.value.kind === 'cpu-motion-field' && still.value.stats.meanMagnitude).toBe(0);
    expect(moved.ok && moved.value.kind === 'cpu-motion-field' && moved.value.stats.meanMagnitude)
      .toBeGreaterThan(0);
  });

  it('reset drops the history, so the next field is zero again', async () => {
    const runtime = createChoresRuntime([new CpuChoreBackend('ts', cpuHost())]);

    await runtime.runJob(motionJob({ pixels: frame(10) }));
    const result = await runtime.runJob(motionJob({ pixels: frame(200), reset: true }));

    expect(result.ok && result.value.kind === 'cpu-motion-field' && result.value.stats.meanMagnitude)
      .toBe(0);
  });

  it('a pinned lane never slides to another lane', async () => {
    const runtime = createChoresRuntime([
      motionGpuLane(),
      new CpuChoreBackend('wasm', cpuHost()),
      new CpuChoreBackend('ts', cpuHost()),
    ]);

    const result = await runtime.runJob(motionJob({ pixels: frame(10), prefer: 'webgpu' }));

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0].backend).toBe('webgpu');
    expect(result.attempts[0].reason).toContain('No GPU-resident source frame');
  });

  it('never silently skips: a total failure reports every attempt', async () => {
    const runtime = createChoresRuntime([
      motionGpuLane(),
      new CpuChoreBackend('wasm', cpuHost()),
      new CpuChoreBackend('ts', cpuHost()),
    ]);

    // No GPU texture and no decoded pixels: nothing can take the job.
    const result = await runtime.runJob(motionJob());

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.attempts.map((a) => a.backend)).toEqual(['webgpu', 'wasm', 'ts']);
    expect(result.attempts[1].reason).toContain('No decoded frame pixels');
    expect(result.attempts[2].reason).toContain('No decoded frame pixels');
  });

  it('publishes motionField breadcrumbs, leaving the image-analysis pair untouched', async () => {
    const fakeWindow = {} as unknown as Window;
    vi.stubGlobal('window', fakeWindow);
    try {
      const runtime = createChoresRuntime([
        new CpuChoreBackend('wasm', cpuHost()),
        new CpuChoreBackend('ts', cpuHost()),
      ]);
      await runtime.runJob(motionJob({ pixels: frame(10) }));

      const w = fakeWindow as unknown as {
        motionFieldBackend?: string | null;
        motionFieldReason?: string | null;
        gpuChoreBackend?: string | null;
      };
      expect(w.motionFieldBackend).toBe('ts-inline');
      expect(w.motionFieldReason).toBeNull();
      // The render-loop op must not stamp over the load-time analysis crumb.
      expect(w.gpuChoreBackend).toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
