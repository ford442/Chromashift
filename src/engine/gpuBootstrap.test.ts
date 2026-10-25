import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildWebGpuCanvasConfiguration,
  buildWebGpuCapabilityReport,
  getGpuFatalError,
  isFatalGpuDeviceRequestError,
  listAvailableOptionalFeatures,
  logAdapterReport,
  configureWebGpuCanvas,
  getCanvasToneMappingSupport,
  getCanvasHdrSupport,
  probeCanvasHdr,
  releasePageGpuDevice,
  requestWebGpuAdapter,
  requestWebGpuDevice,
  withErrorScope,
  attachDeviceDiagnostics,
  resetCanvasToneMappingSupportForTests,
  resetGpuDeviceGateForTests,
  toBootstrapRuntimeError,
  deviceLostRuntimeError,
  createWebGL2Context,
  webglContextLostRuntimeError,
  WebGL2ContextLostError,
  WebGL2UnavailableError,
} from './gpuBootstrap';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  getWebGL2ContextAttributes,
  resolveWebGL2Desynchronized,
  resolveWebGL2PreserveDrawingBuffer,
  webglInternalFormatNote,
  RENDERER_CANVAS_OPTIONS_MATRIX,
  WEBGL2_POWER_PREFERENCE_ATTEMPTS,
  CHROMASHIFT_OPTIONAL_FEATURES,
} from './gpuOptions';

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

describe('withErrorScope', () => {
  function scopedDevice(errorOnPop: GPUError | null) {
    const pops = vi.fn(async () => errorOnPop);
    const device = { pushErrorScope: vi.fn(), popErrorScope: pops } as unknown as GPUDevice;
    return { device, pops };
  }

  it('pops its scope once when the scope caught an error', async () => {
    const { device, pops } = scopedDevice({ message: 'invalid pipeline' } as GPUError);
    await expect(withErrorScope(device, 'validation', 'test', () => 1)).rejects.toThrow(/invalid pipeline/);
    // A second pop would take the enclosing caller's scope.
    expect(pops).toHaveBeenCalledTimes(1);
  });

  it('pops its scope once when the work throws', async () => {
    const { device, pops } = scopedDevice(null);
    await expect(withErrorScope(device, 'validation', 'test', () => {
      throw new Error('boom');
    })).rejects.toThrow('boom');
    expect(pops).toHaveBeenCalledTimes(1);
  });

  it('pops once and returns the result on success', async () => {
    const { device, pops } = scopedDevice(null);
    await expect(withErrorScope(device, 'validation', 'test', () => 7)).resolves.toBe(7);
    expect(pops).toHaveBeenCalledTimes(1);
  });
});

describe('attachDeviceDiagnostics', () => {
  it('stops forwarding device.lost once detached', async () => {
    const device = Object.assign(liveDevice(), { onuncapturederror: null });
    const stale = vi.fn();
    const live = vi.fn();
    const detach = attachDeviceDiagnostics(device, { onLost: stale });
    attachDeviceDiagnostics(device, { onLost: live });
    detach();

    device.lose({ reason: 'unknown', message: 'reset' } as GPUDeviceLostInfo);
    await Promise.resolve();
    await Promise.resolve();

    expect(stale).not.toHaveBeenCalled();
    expect(live).toHaveBeenCalledOnce();
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

  it('hdr-extended configures an rgba16float canvas with extended tone mapping', () => {
    const config = buildWebGpuCanvasConfiguration(device, 'bgra8unorm', {
      presentation: 'hdr-extended',
      toneMappingMode: 'standard',
    });
    expect(config.format).toBe('rgba16float');
    expect(config.toneMapping).toEqual({ mode: 'extended' });
    expect(config.usage).toBe(0x10);
  });

  it('sdr keeps the preferred format', () => {
    const config = buildWebGpuCanvasConfiguration(device, 'bgra8unorm', { presentation: 'sdr' });
    expect(config.format).toBe('bgra8unorm');
  });

  // Nothing copies out of the swap chain (exports and previews read offscreen
  // targets), and an unused COPY_SRC can cost the compositor its scanout path.
  it('configures the swap chain as a render target only', () => {
    for (const presentation of ['sdr', 'hdr-extended'] as const) {
      expect(buildWebGpuCanvasConfiguration(device, 'bgra8unorm', { presentation }).usage).toBe(0x10);
    }
  });
});

describe('getWebGL2ContextAttributes', () => {
  it('never multisamples the default framebuffer — MSAA is the band layers\' renderbuffer', () => {
    expect(getWebGL2ContextAttributes({ antialias: true }).antialias).toBe(false);
    expect(getWebGL2ContextAttributes({ antialias: false }).antialias).toBe(false);
  });

  it('sets the attempt\'s powerPreference, and omits the key for the preference-less attempt', () => {
    expect(getWebGL2ContextAttributes({ antialias: false }, 'low-power').powerPreference).toBe('low-power');
    expect('powerPreference' in getWebGL2ContextAttributes({ antialias: false }, null)).toBe(false);
  });

  it('never asks for desynchronized alongside preserveDrawingBuffer', () => {
    expect(getWebGL2ContextAttributes({ antialias: false }).desynchronized).toBe(false);
    expect(getWebGL2ContextAttributes({ antialias: false, desynchronized: true }).desynchronized).toBe(true);
    expect(getWebGL2ContextAttributes({
      antialias: false,
      desynchronized: true,
      preserveDrawingBuffer: true,
    }).desynchronized).toBe(false);
  });

  it('matches the options matrix documented in docs/gpu-bootstrap.md', () => {
    const attrs = getWebGL2ContextAttributes({ antialias: true });
    const m = RENDERER_CANVAS_OPTIONS_MATRIX.webgl2;
    expect(attrs).toMatchObject({
      alpha: m.alpha,
      antialias: m.antialias,
      preserveDrawingBuffer: m.preserveDrawingBuffer,
      desynchronized: m.desynchronized,
      depth: m.depth,
      stencil: m.stencil,
      premultipliedAlpha: m.premultipliedAlpha,
    });
    const doc = readFileSync(resolve(__dirname, '../../docs/gpu-bootstrap.md'), 'utf8');
    const row = (name: string) => doc.split('\n').find((line) => line.startsWith(`| ${name} |`)) ?? '';
    expect(row('Alpha')).toContain('`alpha: false`');
    expect(row('Antialias')).toContain('`antialias: false`');
    expect(row('Preserve buffer')).toContain('`preserveDrawingBuffer: false`');
    expect(row('Desynchronized')).toContain('`desynchronized: false`');
    expect(row('Depth / stencil')).toContain('`depth: false`, `stencil: false`');
    expect(row('Premultiplied alpha')).toContain('`premultipliedAlpha: false`');
    expect(row('Power')).toContain('`high-performance` → `low-power` → `powerPreference` omitted');
  });
});

describe('createWebGL2Context', () => {
  const gl = { isContextLost: () => false } as unknown as WebGL2RenderingContext;
  // Each call is a fresh canvas: the context cache is keyed on it.
  function canvasGranting(grant: (attrs: WebGLContextAttributes) => boolean) {
    const getContext = vi.fn((_type: string, attrs: WebGLContextAttributes) => (grant(attrs) ? gl : null));
    return { canvas: { getContext } as unknown as HTMLCanvasElement, getContext };
  }

  beforeEach(() => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('boots on low-power when the high-performance context is declined', () => {
    const { canvas, getContext } = canvasGranting((attrs) => attrs.powerPreference === 'low-power');
    expect(createWebGL2Context(canvas, { antialias: false })).toBe(gl);
    expect(getContext.mock.calls.map(([, attrs]) => attrs.powerPreference)).toEqual(['high-performance', 'low-power']);
    expect(console.info).toHaveBeenCalledWith(
      '[Chromashift:GPU] WebGL2 context ready',
      { attempt: 2, powerPreference: 'low-power' },
    );
  });

  it('falls through to a preference-less attempt', () => {
    const { canvas, getContext } = canvasGranting((attrs) => !('powerPreference' in attrs));
    expect(createWebGL2Context(canvas, { antialias: false })).toBe(gl);
    expect(getContext).toHaveBeenCalledTimes(3);
  });

  it('throws a distinct error after three nulls, and never touches WebGPU', () => {
    const requestAdapter = vi.fn();
    vi.stubGlobal('navigator', { gpu: { requestAdapter } });
    const { canvas, getContext } = canvasGranting(() => false);
    expect(() => createWebGL2Context(canvas, { antialias: false })).toThrow(WebGL2UnavailableError);
    expect(getContext).toHaveBeenCalledTimes(WEBGL2_POWER_PREFERENCE_ATTEMPTS.length);
    expect(console.error).toHaveBeenCalledOnce();
    expect(requestAdapter).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('reuses the canvas\'s context instead of calling getContext again', () => {
    const { canvas, getContext } = canvasGranting(() => true);
    createWebGL2Context(canvas, { antialias: false });
    expect(createWebGL2Context(canvas, { antialias: false })).toBe(gl);
    expect(getContext).toHaveBeenCalledOnce();
  });

  it('maps a still-lost context to the recoverable overlay', () => {
    const lostGl = { isContextLost: () => true } as unknown as WebGL2RenderingContext;
    const canvas = { getContext: vi.fn(() => lostGl) } as unknown as HTMLCanvasElement;
    createWebGL2Context(canvas, { antialias: false });
    let thrown: unknown;
    try {
      createWebGL2Context(canvas, { antialias: false });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(WebGL2ContextLostError);
    expect(toBootstrapRuntimeError(thrown)).toEqual(webglContextLostRuntimeError());
    expect(webglContextLostRuntimeError()).toMatchObject({ kind: 'device-lost', recoverable: true });
  });
});

describe('resolveWebGL2Desynchronized', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('is off by default', () => {
    vi.stubGlobal('window', { location: { search: '' } });
    expect(resolveWebGL2Desynchronized(false)).toBe(false);
  });

  it('honours ?desynchronized=1 when preserve-drawing-buffer is off', () => {
    vi.stubGlobal('window', { location: { search: '?desynchronized=1' } });
    expect(resolveWebGL2Desynchronized(false)).toBe(true);
  });

  it('ignores ?desynchronized=1 when preserve-drawing-buffer resolved on', () => {
    vi.stubGlobal('window', { location: { search: '?desynchronized=1' } });
    vi.stubGlobal('navigator', { webdriver: true });
    const preserve = resolveWebGL2PreserveDrawingBuffer();
    expect(preserve).toBe(true);
    expect(resolveWebGL2Desynchronized(preserve)).toBe(false);
  });
});

describe('webglInternalFormatNote', () => {
  it('notes 8-bit targets and is silent for half-float ones', () => {
    expect(webglInternalFormatNote('rgba8')).toMatch(/rgba8.*clip/);
    expect(webglInternalFormatNote('rgba16f')).toBeNull();
  });
});

describe('getWebGL2ContextAttributes defaults', () => {

  it('keeps alpha disabled and preserveDrawingBuffer off by default', () => {
    const attrs = getWebGL2ContextAttributes({ antialias: false });
    expect(attrs.alpha).toBe(false);
    // The live diagnostic session never reads the canvas back; preserving it
    // costs a copy per frame. Screenshot / readback callers opt in below.
    expect(attrs.preserveDrawingBuffer).toBe(false);
    expect(attrs.powerPreference).toBe('high-performance');
  });

  it('allows screenshot/readback callers to opt into preserveDrawingBuffer', () => {
    const attrs = getWebGL2ContextAttributes({
      antialias: false,
      preserveDrawingBuffer: true,
      xrCompatible: true,
    });
    expect(attrs.preserveDrawingBuffer).toBe(true);
    expect(attrs.xrCompatible).toBe(true);
  });
});

describe('resolveWebGL2PreserveDrawingBuffer', () => {
  // The suite runs in the `node` environment, so window/navigator are stubbed
  // rather than mutated.
  function setEnvironment(options: { search?: string; webdriver?: boolean }): void {
    vi.stubGlobal('window', { location: { search: options.search ?? '' } });
    vi.stubGlobal('navigator', { webdriver: options.webdriver ?? false });
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('is off for a normal live session', () => {
    setEnvironment({});
    expect(resolveWebGL2PreserveDrawingBuffer()).toBe(false);
  });

  it('is on under automation so Playwright captures a drawn canvas', () => {
    setEnvironment({ webdriver: true });
    expect(resolveWebGL2PreserveDrawingBuffer()).toBe(true);
  });

  it('lets the URL param force it on in a normal tab', () => {
    setEnvironment({ search: '?preserve_drawing_buffer=1' });
    expect(resolveWebGL2PreserveDrawingBuffer()).toBe(true);
    setEnvironment({ search: '?preserve_drawing_buffer' });
    expect(resolveWebGL2PreserveDrawingBuffer()).toBe(true);
  });

  it('lets the URL param force it off under automation', () => {
    setEnvironment({ search: '?preserve_drawing_buffer=0', webdriver: true });
    expect(resolveWebGL2PreserveDrawingBuffer()).toBe(false);
  });
});

describe('configureWebGpuCanvas tone mapping', () => {
  const device = { features: new Set<string>() } as unknown as GPUDevice;

  function fakeContext(overrides: Partial<GPUCanvasContext> = {}) {
    return {
      configure: vi.fn(),
      unconfigure: vi.fn(),
      ...overrides,
    } as unknown as GPUCanvasContext & { configure: ReturnType<typeof vi.fn> };
  }

  beforeEach(() => {
    resetCanvasToneMappingSupportForTests();
    vi.stubGlobal('GPUTextureUsage', { RENDER_ATTACHMENT: 0x10, COPY_SRC: 0x01 });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'info').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    resetCanvasToneMappingSupportForTests();
  });

  it('requests tone mapping and records support when configure succeeds', () => {
    const context = fakeContext();
    configureWebGpuCanvas(context, device, 'bgra8unorm');
    expect(context.configure).toHaveBeenCalledTimes(1);
    expect(context.configure.mock.calls[0][0].toneMapping).toEqual({ mode: 'standard' });
    expect(getCanvasToneMappingSupport()).toBe(true);
  });

  it('feature-detects a silently dropped toneMapping via getConfiguration', () => {
    // Chrome 131+ echoes the applied configuration; a dictionary member the UA
    // does not know is absent there rather than throwing.
    const context = fakeContext({
      getConfiguration: () => ({ device, format: 'bgra8unorm' }) as GPUCanvasConfiguration,
    } as Partial<GPUCanvasContext>);
    configureWebGpuCanvas(context, device, 'bgra8unorm');
    expect(getCanvasToneMappingSupport()).toBe(false);
    // The probe alone must not cost a second configure.
    expect(context.configure).toHaveBeenCalledTimes(1);
  });

  it('does not throw on the common path once tone mapping is known unsupported', () => {
    const throwing = fakeContext();
    throwing.configure
      .mockImplementationOnce(() => { throw new Error('toneMapping unsupported'); })
      .mockImplementation(() => {});

    configureWebGpuCanvas(throwing, device, 'bgra8unorm');
    expect(throwing.configure).toHaveBeenCalledTimes(2);
    expect(getCanvasToneMappingSupport()).toBe(false);

    // Every later configure (resize, DPR change, Display-P3 toggle) reads the
    // capability bit and never re-enters the catch.
    const next = fakeContext();
    configureWebGpuCanvas(next, device, 'bgra8unorm');
    expect(next.configure).toHaveBeenCalledTimes(1);
    expect(next.configure.mock.calls[0][0].toneMapping).toBeUndefined();
  });
});

describe('configureWebGpuCanvas hdr-extended', () => {
  const device = { features: new Set<string>() } as unknown as GPUDevice;

  function fakeContext(overrides: Partial<GPUCanvasContext> = {}) {
    return {
      configure: vi.fn(),
      unconfigure: vi.fn(),
      ...overrides,
    } as unknown as GPUCanvasContext & { configure: ReturnType<typeof vi.fn> };
  }

  beforeEach(() => {
    resetCanvasToneMappingSupportForTests();
    vi.stubGlobal('GPUTextureUsage', { RENDER_ATTACHMENT: 0x10, COPY_SRC: 0x01 });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'info').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    resetCanvasToneMappingSupportForTests();
  });

  it('presents HDR when the UA applies it', () => {
    const context = fakeContext({
      getConfiguration: () => ({
        device, format: 'rgba16float', toneMapping: { mode: 'extended' },
      }) as GPUCanvasConfiguration,
    } as Partial<GPUCanvasContext>);
    expect(configureWebGpuCanvas(context, device, 'bgra8unorm', { presentation: 'hdr-extended' }))
      .toBe('hdr-extended');
    expect(context.configure).toHaveBeenCalledTimes(1);
    expect(getCanvasHdrSupport()).toBe(true);
  });

  it('falls back to SDR, never unconfigured, when the configure throws', () => {
    const context = fakeContext();
    context.configure
      .mockImplementationOnce(() => { throw new Error('rgba16float unsupported'); })
      .mockImplementation(() => {});
    expect(configureWebGpuCanvas(context, device, 'bgra8unorm', { presentation: 'hdr-extended' }))
      .toBe('sdr');
    expect(context.configure).toHaveBeenCalledTimes(2);
    expect(context.configure.mock.calls[1][0].format).toBe('bgra8unorm');
    expect(getCanvasHdrSupport()).toBe(false);

    // Cached: the next HDR request goes straight to SDR without a throw.
    const next = fakeContext();
    expect(configureWebGpuCanvas(next, device, 'bgra8unorm', { presentation: 'hdr-extended' }))
      .toBe('sdr');
    expect(next.configure).toHaveBeenCalledTimes(1);
  });

  it('falls back to SDR when the UA silently drops extended tone mapping', () => {
    const context = fakeContext({
      getConfiguration: () => ({ device, format: 'rgba16float' }) as GPUCanvasConfiguration,
    } as Partial<GPUCanvasContext>);
    expect(configureWebGpuCanvas(context, device, 'bgra8unorm', { presentation: 'hdr-extended' }))
      .toBe('sdr');
    expect(context.configure.mock.calls.at(-1)?.[0].format).toBe('bgra8unorm');
  });

  it('probeCanvasHdr reports unavailability without throwing', () => {
    const context = fakeContext();
    context.configure.mockImplementation(() => { throw new Error('nope'); });
    const probe = probeCanvasHdr(context, device, 'bgra8unorm');
    expect(probe.available).toBe(false);
    expect(probe.reason).toMatch(/not supported/);
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
