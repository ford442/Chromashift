import { PROFILE_LUT_HEIGHT, PROFILE_LUT_WIDTH } from './colorProfile';

/**
 * GPU-side colour-profile LUT — a 256×3 RGBA8 texture bound to every layer
 * pipeline (binding 5). Always resident so the bind group layout is constant;
 * uploads happen only when the baked LUT array identity changes, which
 * `getColorProfileLut` keeps stable across frames.
 */
export class ProfileLutTexture {
  readonly texture: GPUTexture;
  private readonly device: GPUDevice;
  private uploaded: Uint8Array | null = null;

  constructor(device: GPUDevice) {
    this.device = device;
    this.texture = device.createTexture({
      size: [PROFILE_LUT_WIDTH, PROFILE_LUT_HEIGHT, 1],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
  }

  update(lut: Uint8Array | null | undefined): void {
    if (!lut || lut === this.uploaded) return;
    this.device.queue.writeTexture(
      { texture: this.texture },
      lut as unknown as BufferSource,
      { bytesPerRow: PROFILE_LUT_WIDTH * 4, rowsPerImage: PROFILE_LUT_HEIGHT },
      [PROFILE_LUT_WIDTH, PROFILE_LUT_HEIGHT, 1],
    );
    this.uploaded = lut;
  }

  destroy(): void {
    this.texture.destroy();
    this.uploaded = null;
  }
}
