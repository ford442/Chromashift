import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TextureManager } from '../webgpu/TextureManager';
import { WebGLTextureManager } from '../webgl/WebGLTextureManager';

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

/** Let the queued `onload` → upload continuations run. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  FakeImage.created = [];
  vi.stubGlobal('Image', FakeImage);
  vi.stubGlobal('GPUTextureUsage', { TEXTURE_BINDING: 4, COPY_DST: 2, RENDER_ATTACHMENT: 16 });
  vi.stubGlobal('createImageBitmap', () => Promise.resolve({ width: 1, height: 1, close: () => {} }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('concurrent loadTexture of one URL', () => {
  it('WebGPU: decodes and uploads once, and both callers get that texture', async () => {
    const createTexture = vi.fn(() => ({ destroy: () => {} }));
    const device = {
      createTexture,
      queue: { copyExternalImageToTexture: () => {} },
    } as unknown as GPUDevice;
    const manager = new TextureManager(device);

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
