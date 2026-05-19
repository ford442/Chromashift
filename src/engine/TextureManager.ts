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

  /**
   * Upload raw RGBA8 pixels into a new GPUTexture and register it under
   * `cacheKey` (replacing any previous texture cached under that key). Used
   * by the upscaler flow to swap in a higher-resolution version of an image.
   */
  uploadPixels(cacheKey: string, pixels: Uint8ClampedArray, width: number, height: number): GPUTexture {
    const prev = this.textures.get(cacheKey);
    if (prev) prev.destroy();

    const texture = this.device.createTexture({
      size: [width, height, 1],
      format: 'rgba8unorm',
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_DST |
        GPUTextureUsage.RENDER_ATTACHMENT,
    });
    // Copy into a fresh ArrayBuffer-backed Uint8Array — writeTexture's
    // signature in the WebGPU types requires a strict ArrayBuffer view, not
    // a Uint8ClampedArray that may be backed by SharedArrayBuffer.
    const bytes = new Uint8Array(pixels.byteLength);
    bytes.set(pixels);
    this.device.queue.writeTexture(
      { texture },
      bytes,
      { bytesPerRow: width * 4, rowsPerImage: height },
      [width, height, 1],
    );
    this.textures.set(cacheKey, texture);
    return texture;
  }
}
