import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TextureManager } from '../webgpu/TextureManager';
import { WebGLTextureManager } from '../webgl/WebGLTextureManager';
import { readDiagnostics } from '../diagnostics';
import { estimateRgba8MipChainBytes } from './textureCachePolicy';

/** `Image` whose loads finish only when the test says so. */
class FakeImage {
  static created: FakeImage[] = [];
  crossOrigin = '';
  naturalWidth = 1;
  naturalHeight = 1;
  width = 1;
  height = 1;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  src = '';

  constructor() {
    FakeImage.created.push(this);
  }

  static finishAll(): void {
    for (const image of FakeImage.created) image.onload?.();
  }
}

/**
 * A `GPUDevice` whose every other member is a no-op returning another no-op
 * object, so the mipmap pass runs without a GPU.
 */
function fakeDevice(createTexture: () => unknown): GPUDevice {
  const anything: unknown = new Proxy(() => anything, { get: () => anything });
  return new Proxy({ createTexture }, {
    get: (target, key) => (key in target ? target[key as keyof typeof target] : anything),
  }) as unknown as GPUDevice;
}

/** Let the queued `onload` → upload continuations run. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  FakeImage.created = [];
  vi.stubGlobal('Image', FakeImage);
  vi.stubGlobal('GPUTextureUsage', { TEXTURE_BINDING: 4, COPY_DST: 2, RENDER_ATTACHMENT: 16 });
  vi.stubGlobal('GPUShaderStage', { FRAGMENT: 2 });
  // Like the real thing, a closed bitmap reports a 0×0 size.
  vi.stubGlobal('createImageBitmap', () => {
    const bitmap = { width: 64, height: 32, close: () => { bitmap.width = 0; bitmap.height = 0; } };
    return Promise.resolve(bitmap);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('concurrent loadTexture of one URL', () => {
  it('WebGPU: decodes and uploads once, and both callers get that texture', async () => {
    const createTexture = vi.fn(() => ({ destroy: () => {}, createView: () => ({}) }));
    const manager = new TextureManager(fakeDevice(createTexture));

    const first = manager.loadTexture('/a.png');
    const second = manager.loadTexture('/a.png');
    await flush();
    FakeImage.finishAll();
    const [a, b] = await Promise.all([first, second]);

    expect(FakeImage.created).toHaveLength(1);
    expect(createTexture).toHaveBeenCalledTimes(1);
    expect(a.texture).toBe(b.texture);
  });

  it('WebGL: decodes and uploads once, and both callers get that texture', async () => {
    const createTexture = vi.fn(() => ({}));
    const gl = new Proxy({ createTexture }, {
      get: (target, key) => (key in target ? target[key as keyof typeof target] : () => {}),
    }) as unknown as WebGL2RenderingContext;
    const manager = new WebGLTextureManager(gl);

    const first = manager.loadTexture('/a.png');
    const second = manager.loadTexture('/a.png');
    await flush();
    FakeImage.finishAll();
    const [a, b] = await Promise.all([first, second]);

    expect(FakeImage.created).toHaveLength(1);
    expect(createTexture).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
  });

  it('a failed load is not remembered: the next call tries again', async () => {
    const manager = new WebGLTextureManager({} as WebGL2RenderingContext);

    const failed = manager.loadTexture('/missing.png');
    await flush();
    FakeImage.created[0].onerror?.();
    await expect(failed).rejects.toThrow('Failed to load image: /missing.png');

    void manager.loadTexture('/missing.png');
    await flush();
    expect(FakeImage.created).toHaveLength(2);
  });
});

describe('WebGPU texture byte estimate', () => {
  it('counts the decoded image, not the closed bitmap', async () => {
    vi.stubGlobal('window', {});
    const manager = new TextureManager(fakeDevice(() => ({ destroy: () => {}, createView: () => ({}) })));

    const load = manager.loadTexture('/a.png');
    await flush();
    FakeImage.finishAll();
    await load;
    manager.evictExcept(['/a.png']);

    expect(readDiagnostics().textureCacheBytes).toBe(estimateRgba8MipChainBytes(64, 32));
  });
});
