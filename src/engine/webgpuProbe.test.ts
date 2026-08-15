import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  detectBrowserBrand,
  probeFailureMessage,
  probeWebGPU,
  publishWebGpuProbe,
  recordProbeStageFailure,
  recordProbeSuccess,
} from './webgpuProbe';

function mockAdapter(overrides: Partial<GPUAdapter> = {}): GPUAdapter {
  return {
    features: new Set(['timestamp-query']),
    limits: {
      maxTextureDimension2D: 8192,
      maxBufferSize: 268435456,
      maxComputeInvocationsPerWorkgroup: 256,
      maxStorageBufferBindingSize: 134217728,
    },
    info: {
      vendor: 'intel',
      architecture: 'gen-12lp',
      device: 'iris-xe',
      description: 'Intel Iris Xe Graphics',
    },
    ...overrides,
  } as unknown as GPUAdapter;
}

/** Install window/navigator with an optional `navigator.gpu`. */
function installGlobals(options: {
  secureContext?: boolean;
  gpu?: Partial<GPU> | null;
  userAgent?: string;
  brands?: { brand: string; version: string }[];
} = {}): Record<string, unknown> {
  const win: Record<string, unknown> = {
    isSecureContext: options.secureContext ?? true,
  };
  vi.stubGlobal('window', win);
  vi.stubGlobal('navigator', {
    gpu: options.gpu === null ? undefined : options.gpu,
    userAgent: options.userAgent ?? 'Mozilla/5.0 Chrome/141.0.0.0 Safari/537.36',
    userAgentData: options.brands ? { brands: options.brands } : undefined,
  } as unknown as Navigator);
  return win;
}

describe('detectBrowserBrand', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('names Edge distinctly from Chromium via userAgentData', () => {
    installGlobals({
      brands: [
        { brand: 'Not)A;Brand', version: '99' },
        { brand: 'Chromium', version: '141' },
        { brand: 'Microsoft Edge', version: '141' },
      ],
    });
    expect(detectBrowserBrand()).toBe('Microsoft Edge 141');
  });

  it('falls back to a UA sniff that maps Edg → Edge', () => {
    installGlobals({ userAgent: 'Mozilla/5.0 Chrome/141.0.0.0 Edg/141.0.3537.57' });
    expect(detectBrowserBrand()).toBe('Edge 141.0.3537.57');
  });
});

describe('probeWebGPU', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('fails on an insecure context before touching navigator.gpu', async () => {
    installGlobals({ secureContext: false, gpu: { requestAdapter: vi.fn() } });
    const result = await probeWebGPU();

    expect(result.ok).toBe(false);
    expect(result.stage).toBe('secure-context');
    expect(result.reason).toContain('secure context');
  });

  it('fails when the browser exposes no navigator.gpu', async () => {
    installGlobals({ gpu: null });
    const result = await probeWebGPU();

    expect(result.ok).toBe(false);
    expect(result.stage).toBe('navigator-gpu');
    expect(result.adapter).toBeNull();
  });

  it('fails when no adapter is offered, still reporting the browser', async () => {
    installGlobals({
      gpu: { requestAdapter: vi.fn(async () => null) },
      userAgent: 'Mozilla/5.0 Chrome/141.0.0.0 Edg/141.0.3537.57',
    });
    const result = await probeWebGPU();

    expect(result.ok).toBe(false);
    expect(result.stage).toBe('adapter');
    expect(result.reason).toContain('No WebGPU adapter');
    expect(result.browser).toContain('Edge');
  });

  it('reports a throwing requestAdapter rather than rejecting', async () => {
    installGlobals({
      gpu: {
        requestAdapter: vi.fn(async () => {
          throw new Error('GPU process crashed');
        }),
      },
    });
    const result = await probeWebGPU();

    expect(result.ok).toBe(false);
    expect(result.stage).toBe('adapter');
    expect(result.reason).toContain('GPU process crashed');
  });

  it('never calls requestDevice — the real bootstrap owns the only one', async () => {
    const requestDevice = vi.fn();
    installGlobals({
      gpu: { requestAdapter: vi.fn(async () => mockAdapter({ requestDevice } as never)) },
    });

    const result = await probeWebGPU();

    expect(result.ok).toBe(true);
    expect(requestDevice).not.toHaveBeenCalled();
  });

  it('succeeds with adapter identity, features, and limits', async () => {
    installGlobals({
      gpu: { requestAdapter: vi.fn(async () => mockAdapter()) },
    });
    const result = await probeWebGPU();

    expect(result.ok).toBe(true);
    expect(result.stage).toBe('ok');
    expect(result.reason).toBeNull();
    expect(result.adapter).toEqual({
      vendor: 'intel',
      architecture: 'gen-12lp',
      device: 'iris-xe',
      description: 'Intel Iris Xe Graphics',
    });
    expect(result.features).toContain('timestamp-query');
    expect(result.limits?.maxTextureDimension2D).toBe(8192);
  });
});

describe('probe breadcrumbs', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('publishes window.webgpuProbe and usingWebGPU', async () => {
    const win = installGlobals({
      gpu: { requestAdapter: vi.fn(async () => mockAdapter()) },
    });
    const result = await probeWebGPU();
    publishWebGpuProbe(result);

    expect(win.usingWebGPU).toBe(true);
    expect((win.webgpuProbe as { stage: string }).stage).toBe('ok');
  });

  it('folds a device-stage failure into an adapter-stage success', async () => {
    const win = installGlobals({
      gpu: { requestAdapter: vi.fn(async () => mockAdapter()) },
    });
    const probe = await probeWebGPU();
    expect(probe.ok).toBe(true);

    const failed = recordProbeStageFailure(probe, 'device', 'requestDevice() rejected');

    expect(failed.ok).toBe(false);
    expect(failed.stage).toBe('device');
    // Adapter detail survives, which is what makes Chrome-vs-Edge legible.
    expect(failed.adapter?.device).toBe('iris-xe');
    expect(win.usingWebGPU).toBe(false);
  });

  it('recordProbeSuccess promotes the probe once the device is live', async () => {
    const win = installGlobals({
      gpu: { requestAdapter: vi.fn(async () => mockAdapter()) },
    });
    const probe = await probeWebGPU();
    recordProbeStageFailure(probe, 'device', 'transient');
    expect(win.usingWebGPU).toBe(false);

    recordProbeSuccess(probe);
    expect(win.usingWebGPU).toBe(true);
  });

  it('builds a blocking message naming stage, browser, and adapter', async () => {
    installGlobals({ gpu: { requestAdapter: vi.fn(async () => null) } });
    const probe = await probeWebGPU();
    const { message, detail } = probeFailureMessage(probe);

    expect(message).toContain('WebGPU is required');
    expect(detail).toContain('[adapter]');
    expect(detail).toContain('no adapter');
    expect(detail).toContain('Browser:');
  });
});
