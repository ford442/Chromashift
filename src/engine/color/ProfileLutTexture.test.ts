import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProfileLutTexture } from './ProfileLutTexture';
import { profileLutBytes } from './colorProfile';

describe('ProfileLutTexture', () => {
  const created: { size: number[]; destroy: ReturnType<typeof vi.fn> }[] = [];
  const writeTexture = vi.fn();
  const device = {
    createTexture: vi.fn((descriptor: GPUTextureDescriptor) => {
      const texture = { size: [...(descriptor.size as number[])], destroy: vi.fn() };
      created.push(texture);
      return texture;
    }),
    queue: { writeTexture },
  } as unknown as GPUDevice;

  beforeEach(() => {
    created.length = 0;
    writeTexture.mockClear();
    vi.stubGlobal('GPUTextureUsage', { TEXTURE_BINDING: 4, COPY_DST: 2 });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('starts at three rows and uploads a three-row LUT in place', () => {
    const lut = new ProfileLutTexture(device);
    const initial = lut.texture;
    expect(created).toHaveLength(1);
    expect(created[0].size).toEqual([256, 3, 1]);

    lut.update(new Uint8Array(profileLutBytes(3)));
    expect(lut.texture).toBe(initial);
    expect(writeTexture).toHaveBeenCalledTimes(1);
    expect(writeTexture.mock.calls[0][3]).toEqual([256, 3, 1]);
  });

  it('skips the upload when the LUT array identity is unchanged', () => {
    const lut = new ProfileLutTexture(device);
    const data = new Uint8Array(profileLutBytes(3));
    lut.update(data);
    lut.update(data);
    lut.update(null);
    expect(writeTexture).toHaveBeenCalledTimes(1);
  });

  it('recreates the texture when the row count changes, so bind groups rebind', () => {
    const lut = new ProfileLutTexture(device);
    const three = lut.texture;

    lut.update(new Uint8Array(profileLutBytes(5)));
    expect(lut.texture).not.toBe(three);
    expect(created[0].destroy).toHaveBeenCalledTimes(1);
    expect(created[1].size).toEqual([256, 5, 1]);
    expect(writeTexture.mock.calls[0][2]).toEqual({ bytesPerRow: 1024, rowsPerImage: 5 });

    const five = lut.texture;
    lut.update(new Uint8Array(profileLutBytes(5)));
    expect(lut.texture).toBe(five);
    expect(created).toHaveLength(2);
  });
});
