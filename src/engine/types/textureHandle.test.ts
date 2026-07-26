import { describe, expect, it } from 'vitest';
import {
  assertTextureBackend,
  createWebGlTextureHandle,
  createWebGpuTextureHandle,
  isChromashiftTextureHandle,
  webGpuTextureFromHandle,
} from './TextureHandle';

describe('TextureHandle', () => {
  it('isChromashiftTextureHandle accepts webgpu and webgl variants', () => {
    const gpuTexture = {} as GPUTexture;
    const glTexture = {} as WebGLTexture;

    expect(isChromashiftTextureHandle(createWebGpuTextureHandle(gpuTexture))).toBe(true);
    expect(isChromashiftTextureHandle(createWebGlTextureHandle(glTexture, 640, 480, 'url'))).toBe(true);
  });

  it('isChromashiftTextureHandle rejects garbage', () => {
    expect(isChromashiftTextureHandle(null)).toBe(false);
    expect(isChromashiftTextureHandle(undefined)).toBe(false);
    expect(isChromashiftTextureHandle({ backend: 'webgpu' })).toBe(false);
    expect(isChromashiftTextureHandle({ backend: 'webgl', texture: {} })).toBe(false);
    expect(isChromashiftTextureHandle({ backend: 'metal', texture: {} })).toBe(false);
  });

  it('assertTextureBackend throws for wrong backend', () => {
    const gpuHandle = createWebGpuTextureHandle({} as GPUTexture);
    const glHandle = createWebGlTextureHandle({} as WebGLTexture, 1, 1, 'k');

    expect(() => assertTextureBackend(gpuHandle, 'webgpu')).not.toThrow();
    expect(() => assertTextureBackend(glHandle, 'webgl')).not.toThrow();
    expect(() => assertTextureBackend(gpuHandle, 'webgl')).toThrow(/Expected a webgl texture handle/);
    expect(() => assertTextureBackend(glHandle, 'webgpu')).toThrow(/Expected a webgpu texture handle/);
  });

  it('webGpuTextureFromHandle returns texture only for webgpu handles', () => {
    const gpuTexture = {} as GPUTexture;
    const gpuHandle = createWebGpuTextureHandle(gpuTexture);
    const glHandle = createWebGlTextureHandle({} as WebGLTexture, 1, 1, 'k');

    expect(webGpuTextureFromHandle(gpuHandle)).toBe(gpuTexture);
    expect(webGpuTextureFromHandle(glHandle)).toBeNull();
    expect(webGpuTextureFromHandle(null)).toBeNull();
    expect(webGpuTextureFromHandle(undefined)).toBeNull();
  });
});
