import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readDiagnostics } from '../diagnostics';
import { TextureCache } from './TextureCache';
import { estimateRgba8MipChainBytes, estimateRgba8SingleLevelBytes } from './textureCachePolicy';

interface FakeTexture {
  id: string;
}

function cache() {
  const destroyed: string[] = [];
  const textures = new TextureCache<FakeTexture>((texture) => { destroyed.push(texture.id); });
  return { textures, destroyed };
}

const upload = (id: string, width = 4, height = 4) => vi.fn(async () => ({ texture: { id }, width, height }));

function breadcrumbs() {
  const { textureCacheSize: size, textureCacheBytes: bytes } = readDiagnostics();
  return { size, bytes };
}

beforeEach(() => {
  vi.stubGlobal('window', {});
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('TextureCache', () => {
  it('uploads a URL once and serves the cached texture after', async () => {
    const { textures } = cache();
    const first = upload('a');
    const a = await textures.load('/a.png', first);
    const again = await textures.load('/a.png', upload('other'));
    expect(again).toBe(a);
    expect(first).toHaveBeenCalledTimes(1);
  });

  it('counts a loaded texture against the byte budget', async () => {
    const { textures } = cache();
    await textures.load('/a.png', upload('a', 64, 32));
    textures.evictExcept(['/a.png']);
    expect(breadcrumbs()).toEqual({ size: 1, bytes: estimateRgba8MipChainBytes(64, 32) });
  });

  it('replace destroys what was cached under the key', async () => {
    const { textures, destroyed } = cache();
    await textures.load('/a.png', upload('small'));
    textures.replace('/a.png', { id: 'large' }, 8, 8);
    expect(destroyed).toEqual(['small']);
    expect(await textures.load('/a.png', upload('unused'))).toEqual({ id: 'large' });
  });

  it('reuses a video texture until the frame size changes', () => {
    const { textures, destroyed } = cache();
    let n = 0;
    const create = vi.fn(() => ({ id: `frame-${n++}` }));
    const a = textures.video('live', 640, 480, create);
    expect(textures.video('live', 640, 480, create)).toBe(a);
    const b = textures.video('live', 1280, 720, create);
    expect(b).not.toBe(a);
    expect(create).toHaveBeenCalledTimes(2);
    expect(destroyed).toEqual(['frame-0']);
    expect(breadcrumbs()).toEqual({ size: 1, bytes: estimateRgba8SingleLevelBytes(1280, 720) });

    textures.release('live');
    expect(destroyed).toEqual(['frame-0', 'frame-1']);
    expect(breadcrumbs()).toEqual({ size: 0, bytes: 0 });
  });

  it('evicts unkept blob: URLs and clears everything on clear', async () => {
    const { textures, destroyed } = cache();
    await textures.load('blob:x', upload('blob'));
    await textures.load('/kept.png', upload('kept'));
    textures.evictExcept(['/kept.png']);
    expect(destroyed).toEqual(['blob']);
    textures.clear();
    expect(destroyed).toEqual(['blob', 'kept']);
  });

  it('shares an in-flight load, and forgets a failed one', async () => {
    const { textures } = cache();
    let fail!: (error: Error) => void;
    const failing = vi.fn(() => new Promise<never>((_, reject) => { fail = reject; }));
    const first = textures.load('/a.png', failing);
    const second = textures.load('/a.png', failing);
    expect(second).toBe(first);
    fail(new Error('404'));
    await expect(first).rejects.toThrow('404');

    const retry = upload('a');
    await textures.load('/a.png', retry);
    expect(retry).toHaveBeenCalledTimes(1);
  });
});
