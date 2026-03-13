/**
 * TextureManager
 *
 * Fetches image URLs from a JSON endpoint (simulating the PHP backend)
 * and uploads decoded images to GPU textures. No CPU-side pixel
 * manipulation is performed — all image data is transferred directly
 * to the GPU via `copyExternalImageToTexture`.
 */

export interface ImageEntry {
  url: string;
  label?: string;
}

export class TextureManager {
  private device: GPUDevice;
  private textures: Map<string, GPUTexture> = new Map();

  constructor(device: GPUDevice) {
    this.device = device;
  }

  /** Fetch a list of image entries from a JSON endpoint. */
  async fetchImageList(endpoint: string): Promise<ImageEntry[]> {
    const response = await fetch(endpoint);
    if (!response.ok) {
      throw new Error(`Failed to fetch image list from ${endpoint}: ${response.statusText}`);
    }
    const data: ImageEntry[] = await response.json();
    return data;
  }

  /**
   * Load an image from a URL and upload it to a GPU texture.
   * Returns the cached texture if already loaded.
   */
  async loadTexture(url: string): Promise<GPUTexture> {
    if (this.textures.has(url)) {
      return this.textures.get(url)!;
    }

    const image = new Image();
    image.crossOrigin = 'anonymous';

    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error(`Failed to load image: ${url}`));
      image.src = url;
    });

    await image.decode();

    const imageBitmap = await createImageBitmap(image);
    const texture = this.device.createTexture({
      size: [imageBitmap.width, imageBitmap.height, 1],
      format: 'rgba8unorm',
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_DST |
        GPUTextureUsage.RENDER_ATTACHMENT,
    });

    this.device.queue.copyExternalImageToTexture(
      { source: imageBitmap },
      { texture },
      [imageBitmap.width, imageBitmap.height],
    );

    imageBitmap.close();
    this.textures.set(url, texture);
    return texture;
  }

  /** Destroy all managed GPU textures and free GPU memory. */
  destroy(): void {
    for (const texture of this.textures.values()) {
      texture.destroy();
    }
    this.textures.clear();
  }
}
