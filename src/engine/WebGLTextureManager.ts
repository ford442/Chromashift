import type { ImageEntry } from './TextureManager';
import type { ChromashiftTextureManager } from './RendererTypes';
import { publishTextureCacheBreadcrumbs } from './textureCacheBreadcrumbs';
import {
  estimateWebGlTextureBytes,
  TextureCacheTracker,
} from './textureCachePolicy';
import {
  createWebGlTextureHandle,
  type ChromashiftTextureHandle,
  type WebGlTextureHandle,
} from './types/TextureHandle';

export type { WebGLImageTexture, WebGlTextureHandle } from './types/TextureHandle';

export class WebGLTextureManager implements ChromashiftTextureManager {
  private gl: WebGL2RenderingContext;
  private textures = new Map<string, WebGlTextureHandle>();
  private cacheTracker = new TextureCacheTracker();

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
  }

  async fetchImageList(endpoint: string, signal?: AbortSignal): Promise<ImageEntry[]> {
    const response = await fetch(endpoint, { signal });
    if (!response.ok) {
      throw new Error(`Failed to fetch image list from ${endpoint}: ${response.statusText}`);
    }
    return await response.json() as ImageEntry[];
  }

  async loadTexture(url: string): Promise<ChromashiftTextureHandle> {
    const cached = this.textures.get(url);
    if (cached) {
      const bytes = this.cacheTracker.bytesFor(url);
      if (bytes !== undefined) this.cacheTracker.touch(url, bytes);
      return cached;
    }

    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error(`Failed to load image: ${url}`));
      img.src = url;
    });

    const texture = this.createTextureFromSource(image);
    const entry = createWebGlTextureHandle(
      texture,
      image.naturalWidth,
      image.naturalHeight,
      url,
    );
    this.textures.set(url, entry);
    this.cacheTracker.touch(url, estimateWebGlTextureBytes(image.naturalWidth, image.naturalHeight));
    return entry;
  }

  uploadPixels(cacheKey: string, pixels: Uint8ClampedArray, width: number, height: number): ChromashiftTextureHandle {
    const previous = this.textures.get(cacheKey);
    if (previous) {
      this.gl.deleteTexture(previous.texture);
      this.cacheTracker.remove(cacheKey);
    }

    const texture = this.gl.createTexture();
    if (!texture) throw new Error('Failed to create WebGL texture.');

    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    this.configureTexture(width, height);

    const entry = createWebGlTextureHandle(texture, width, height, cacheKey);
    this.textures.set(cacheKey, entry);
    this.cacheTracker.touch(cacheKey, estimateWebGlTextureBytes(width, height));
    publishTextureCacheBreadcrumbs(this.cacheTracker.entryCount, this.cacheTracker.estimatedBytes);
    return entry;
  }

  destroy(): void {
    for (const entry of this.textures.values()) {
      this.gl.deleteTexture(entry.texture);
    }
    this.textures.clear();
    this.cacheTracker.clear();
    publishTextureCacheBreadcrumbs(0, 0);
  }

  /** See `TextureManager.evictExcept` — same LRU byte budget and blob fast-path policy. */
  evictExcept(keepUrls: Iterable<string>): void {
    this.cacheTracker.evictToBudget(keepUrls, (key) => this.destroyKey(key));
    publishTextureCacheBreadcrumbs(this.cacheTracker.entryCount, this.cacheTracker.estimatedBytes);
  }

  private destroyKey(key: string): void {
    const entry = this.textures.get(key);
    if (entry) this.gl.deleteTexture(entry.texture);
    this.textures.delete(key);
    this.cacheTracker.remove(key);
  }

  private createTextureFromSource(source: HTMLImageElement): WebGLTexture {
    const gl = this.gl;
    const texture = gl.createTexture();
    if (!texture) throw new Error('Failed to create WebGL texture.');
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    this.configureTexture(source.width, source.height);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    return texture;
  }

  private configureTexture(width: number, height: number): void {
    const gl = this.gl;
    const isPowerOfTwo = (value: number) => (value & (value - 1)) === 0;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    if (isPowerOfTwo(width) && isPowerOfTwo(height)) {
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.generateMipmap(gl.TEXTURE_2D);
    } else {
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    }
  }
}
