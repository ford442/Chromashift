import type { RendererBackend } from './RendererContracts';

export interface WebGpuTextureHandle {
  readonly backend: 'webgpu';
  readonly texture: GPUTexture;
}

export interface WebGlTextureHandle {
  readonly backend: 'webgl';
  readonly texture: WebGLTexture;
  readonly width: number;
  readonly height: number;
  readonly cacheKey: string;
}

export type ChromashiftTextureHandle = WebGpuTextureHandle | WebGlTextureHandle;

/** @deprecated Use {@link WebGlTextureHandle} */
export type WebGLImageTexture = WebGlTextureHandle;

export function createWebGpuTextureHandle(texture: GPUTexture): WebGpuTextureHandle {
  return { backend: 'webgpu', texture };
}

export function createWebGlTextureHandle(
  texture: WebGLTexture,
  width: number,
  height: number,
  cacheKey: string,
): WebGlTextureHandle {
  return { backend: 'webgl', texture, width, height, cacheKey };
}

export function isChromashiftTextureHandle(value: unknown): value is ChromashiftTextureHandle {
  if (typeof value !== 'object' || value === null) return false;
  const backend = (value as ChromashiftTextureHandle).backend;
  if (backend === 'webgpu') {
    const texture = (value as WebGpuTextureHandle).texture;
    return texture != null && typeof texture === 'object';
  }
  if (backend === 'webgl') {
    const handle = value as WebGlTextureHandle;
    return (
      handle.texture != null
      && typeof handle.texture === 'object'
      && typeof handle.width === 'number'
      && typeof handle.height === 'number'
      && typeof handle.cacheKey === 'string'
    );
  }
  return false;
}

export function assertTextureBackend(
  handle: ChromashiftTextureHandle,
  backend: 'webgpu',
): asserts handle is WebGpuTextureHandle;
export function assertTextureBackend(
  handle: ChromashiftTextureHandle,
  backend: 'webgl',
): asserts handle is WebGlTextureHandle;
export function assertTextureBackend(
  handle: ChromashiftTextureHandle,
  backend: RendererBackend,
): void {
  if (handle.backend !== backend) {
    throw new Error(`Expected a ${backend} texture handle, received ${handle.backend}.`);
  }
}

export function webGpuTextureFromHandle(
  handle: ChromashiftTextureHandle | null | undefined,
): GPUTexture | null {
  return handle?.backend === 'webgpu' ? handle.texture : null;
}
