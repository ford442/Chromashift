import { packRgbaRows } from '../engine/webgpu/GpuReadback';
import type { PresentationTarget } from '../engine/webgpu/presentationTarget';

/** What `GPUCanvasContext.configure` accepts as a format; anything else throws there too. */
const CANVAS_FORMATS: ReadonlySet<GPUTextureFormat> = new Set(['bgra8unorm', 'rgba8unorm', 'rgba16float']);

/**
 * An offscreen {@link PresentationTarget}: what the primary slot presents
 * into when there is no canvas (docs/HEADLESS.md).
 *
 * It keeps a canvas context's contract, so `configureWebGpuCanvas` and the
 * HDR probe configure it unchanged: `configure` takes the same configuration
 * (and refuses a format a canvas would), and `getCurrentTexture` hands back a
 * texture of that format and usage at the surface's size. `COPY_SRC` is added
 * to the configured usage, so a frame can be read back with {@link read}.
 *
 * Unlike a swap chain the texture is not replaced each frame: it is the same
 * texture until a resize or a reconfigure.
 */
export class HeadlessSurface implements PresentationTarget {
  private width: number;
  private height: number;
  private configuration: GPUCanvasConfiguration | null = null;
  private texture: GPUTexture | null = null;

  constructor(width: number, height: number) {
    this.width = Math.max(1, Math.floor(width));
    this.height = Math.max(1, Math.floor(height));
  }

  get size(): { width: number; height: number } {
    return { width: this.width, height: this.height };
  }

  /** The next `getCurrentTexture` allocates at the new size, like a resized canvas. */
  resize(width: number, height: number): void {
    const nextWidth = Math.max(1, Math.floor(width));
    const nextHeight = Math.max(1, Math.floor(height));
    if (nextWidth === this.width && nextHeight === this.height) return;
    this.width = nextWidth;
    this.height = nextHeight;
    this.dropTexture();
  }

  configure(configuration: GPUCanvasConfiguration): void {
    if (!CANVAS_FORMATS.has(configuration.format)) {
      throw new TypeError(`HeadlessSurface: ${configuration.format} is not a canvas format.`);
    }
    this.configuration = configuration;
    this.dropTexture();
  }

  unconfigure(): void {
    this.configuration = null;
    this.dropTexture();
  }

  getConfiguration(): GPUCanvasConfigurationOut | null {
    const config = this.configuration;
    if (!config) return null;
    return {
      device: config.device,
      format: config.format,
      usage: config.usage ?? GPUTextureUsage.RENDER_ATTACHMENT,
      viewFormats: [...(config.viewFormats ?? [])],
      colorSpace: config.colorSpace ?? 'srgb',
      alphaMode: config.alphaMode ?? 'opaque',
      toneMapping: config.toneMapping ?? { mode: 'standard' },
    };
  }

  getCurrentTexture(): GPUTexture {
    const config = this.configuration;
    if (!config) throw new Error('HeadlessSurface: getCurrentTexture() before configure().');
    this.texture ??= config.device.createTexture({
      label: 'HeadlessSurface',
      size: [this.width, this.height, 1],
      format: config.format,
      usage: (config.usage ?? GPUTextureUsage.RENDER_ATTACHMENT) | GPUTextureUsage.COPY_SRC,
      viewFormats: config.viewFormats,
    });
    return this.texture;
  }

  /**
   * The current texture's pixels as tightly packed RGBA8 (R and B swapped
   * back from a `bgra8unorm` configure). An `rgba16float` (HDR) surface is not
   * readable this way.
   */
  async read(): Promise<{ width: number; height: number; data: Uint8ClampedArray }> {
    const texture = this.getCurrentTexture();
    if (texture.format === 'rgba16float') {
      throw new Error('HeadlessSurface: read() returns 8-bit RGBA; this surface is rgba16float.');
    }
    const device = this.configuration!.device;
    const { width, height } = texture;
    const bytesPerRow = Math.ceil((width * 4) / 256) * 256;
    const staging = device.createBuffer({
      size: bytesPerRow * height,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    const enc = device.createCommandEncoder();
    enc.copyTextureToBuffer({ texture }, { buffer: staging, bytesPerRow }, [width, height, 1]);
    device.queue.submit([enc.finish()]);
    try {
      await staging.mapAsync(GPUMapMode.READ);
      const data = packRgbaRows(new Uint8Array(staging.getMappedRange()), bytesPerRow, width, height, texture.format);
      staging.unmap();
      return { width, height, data };
    } finally {
      staging.destroy();
    }
  }

  destroy(): void {
    this.unconfigure();
  }

  private dropTexture(): void {
    this.texture?.destroy();
    this.texture = null;
  }
}
