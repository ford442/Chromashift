import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildWebGpuCanvasConfiguration,
  configureWebGpuCanvas,
  getCanvasToneMappingSupport,
  getCanvasHdrSupport,
  probeCanvasHdr,
  resetCanvasToneMappingSupportForTests,
} from './canvasConfig';

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
    expect(context.configure.mock.calls[0]![0].toneMapping).toEqual({ mode: 'standard' });
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
    expect(next.configure.mock.calls[0]![0].toneMapping).toBeUndefined();
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
    expect(context.configure.mock.calls[1]![0].format).toBe('bgra8unorm');
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
