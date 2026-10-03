import { PROFILE_LUT_MIN_ROWS, PROFILE_LUT_WIDTH } from './colorProfile';

/**
 * GPU-side colour-profile LUT — a 256×rows RGBA8 texture bound to every layer
 * pipeline (binding 5). Always resident so the bind group layout is constant;
 * uploads happen only when the baked LUT array identity changes, which
 * `getColorProfileLut` keeps stable across frames.
 *
 * The row count follows the baked LUT (`profileLutRows(layerCount)`, never
 * below three). A change recreates the texture, so `texture` changes identity
 * — the layer bind-group cache and the graph executor both rebind on that.
 */
export class ProfileLutTexture {
  private readonly device: GPUDevice;
  private current: GPUTexture;
  private rows = PROFILE_LUT_MIN_ROWS;
  private uploaded: Uint8Array | null = null;

  constructor(device: GPUDevice) {
    this.device = device;
    this.current = this.create(this.rows);
  }

  get texture(): GPUTexture {
    return this.current;
  }

  update(lut: Uint8Array | null | undefined): void {
    if (!lut || lut === this.uploaded) return;
    const rows = lut.length / (PROFILE_LUT_WIDTH * 4);
    if (rows !== this.rows) {
      this.current.destroy();
      this.current = this.create(rows);
      this.rows = rows;
    }
    this.device.queue.writeTexture(
      { texture: this.current },
      lut as unknown as BufferSource,
      { bytesPerRow: PROFILE_LUT_WIDTH * 4, rowsPerImage: rows },
      [PROFILE_LUT_WIDTH, rows, 1],
    );
    this.uploaded = lut;
  }

  destroy(): void {
    this.current.destroy();
    this.uploaded = null;
  }

  private create(rows: number): GPUTexture {
    return this.device.createTexture({
      size: [PROFILE_LUT_WIDTH, rows, 1],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
  }
}
