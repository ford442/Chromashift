import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { configureWebGpuCanvas, resetCanvasToneMappingSupportForTests } from '../engine/webgpu/canvasConfig';
import { HeadlessSurface } from './HeadlessSurface';

const RENDER_ATTACHMENT = 0x10;
const COPY_SRC = 0x01;

interface TextureRecord {
  descriptor: GPUTextureDescriptor;
  destroyed: boolean;
}

function mockDevice(): { device: GPUDevice; textures: TextureRecord[] } {
  const textures: TextureRecord[] = [];
  const device = {
    createTexture(descriptor: GPUTextureDescriptor) {
      const record: TextureRecord = { descriptor, destroyed: false };
      textures.push(record);
      return {
        format: descriptor.format,
        destroy: () => {
          record.destroyed = true;
        },
      } as unknown as GPUTexture;
    },
  } as unknown as GPUDevice;
  return { device, textures };
}

describe('HeadlessSurface', () => {
  beforeEach(() => {
    vi.stubGlobal('GPUTextureUsage', { RENDER_ATTACHMENT, COPY_SRC });
    resetCanvasToneMappingSupportForTests();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('refuses a format a canvas context refuses', () => {
    const { device } = mockDevice();
    const surface = new HeadlessSurface(8, 8);
    expect(() => surface.configure({ device, format: 'rgba8unorm-srgb' })).toThrow(TypeError);
  });

  it('has no texture before it is configured', () => {
    expect(() => new HeadlessSurface(8, 8).getCurrentTexture()).toThrow(/before configure/);
  });

  it('hands back one texture, readable, until a resize or a reconfigure', () => {
    const { device, textures } = mockDevice();
    const surface = new HeadlessSurface(64.7, 0);
    expect(surface.size).toEqual({ width: 64, height: 1 });
    surface.configure({ device, format: 'rgba8unorm' });

    const first = surface.getCurrentTexture();
    expect(surface.getCurrentTexture()).toBe(first);
    expect(textures).toHaveLength(1);
    expect(textures[0]!.descriptor).toMatchObject({ size: [64, 1, 1], usage: RENDER_ATTACHMENT | COPY_SRC });

    surface.resize(64, 1);
    expect(surface.getCurrentTexture()).toBe(first);

    surface.resize(32, 16);
    expect(textures[0]!.destroyed).toBe(true);
    surface.getCurrentTexture();
    expect(textures[1]!.descriptor.size).toEqual([32, 16, 1]);

    surface.configure({ device, format: 'bgra8unorm' });
    expect(textures[1]!.destroyed).toBe(true);
    expect(surface.getCurrentTexture().format).toBe('bgra8unorm');
  });

  it('reports what it was configured with, defaults filled in as a canvas context does', () => {
    const { device } = mockDevice();
    const surface = new HeadlessSurface(8, 8);
    expect(surface.getConfiguration()).toBeNull();
    surface.configure({ device, format: 'rgba8unorm' });
    expect(surface.getConfiguration()).toEqual({
      device,
      format: 'rgba8unorm',
      usage: RENDER_ATTACHMENT,
      viewFormats: [],
      colorSpace: 'srgb',
      alphaMode: 'opaque',
      toneMapping: { mode: 'standard' },
    });
    surface.unconfigure();
    expect(surface.getConfiguration()).toBeNull();
  });

  // The page's one configure path drives it unchanged — no headless variant.
  it('is configured by configureWebGpuCanvas, HDR included', () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const { device } = mockDevice();
    const surface = new HeadlessSurface(8, 8);

    expect(configureWebGpuCanvas(surface, device, 'rgba8unorm', { presentation: 'sdr' })).toBe('sdr');
    expect(surface.getConfiguration()).toMatchObject({ format: 'rgba8unorm', toneMapping: { mode: 'standard' } });

    expect(configureWebGpuCanvas(surface, device, 'rgba8unorm', { presentation: 'hdr-extended' })).toBe('hdr-extended');
    expect(surface.getConfiguration()).toMatchObject({ format: 'rgba16float', toneMapping: { mode: 'extended' } });
  });

  it('will not read an HDR surface back as 8-bit', async () => {
    const { device } = mockDevice();
    const surface = new HeadlessSurface(8, 8);
    surface.configure({ device, format: 'rgba16float' });
    await expect(surface.read()).rejects.toThrow(/rgba16float/);
  });
});
