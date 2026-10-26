import type { ImageEntry } from '../webgpu/TextureManager';
import type { ChromashiftTextureManager } from '../types/RendererContracts';
import { shouldRecreateVideoTexture, videoFrameSizeKey } from '../live/liveSourceTexture';
import { publishTextureCacheBreadcrumbs } from '../textures/textureCacheBreadcrumbs';
import {
  estimateRgba8MipChainBytes,
  estimateRgba8SingleLevelBytes,
  TextureCacheTracker,
} from '../textures/textureCachePolicy';
import {
  createWebGlTextureHandle,
  type ChromashiftTextureHandle,
  type WebGlTextureHandle,
} from '../types/TextureHandle';

export type { WebGLImageTexture, WebGlTextureHandle } from '../types/TextureHandle';

export class WebGLTextureManager implements ChromashiftTextureManager {
  private gl: WebGL2RenderingContext;
  private textures = new Map<string, WebGlTextureHandle>();
  private cacheTracker = new TextureCacheTracker();
  /** In-flight loads by URL — see `TextureManager.pending`. */
  private pending = new Map<string, Promise<ChromashiftTextureHandle>>();
  /** Frame size (`"WxH"`) of the texture currently cached under each live-source key. */
  private videoTextureSizes = new Map<string, string>();

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
    const inFlight = this.pending.get(url);
    if (inFlight) return inFlight;

    const load = this.uploadFromUrl(url).finally(() => this.pending.delete(url));
    this.pending.set(url, load);
    return load;
  }

  private async uploadFromUrl(url: string): Promise<ChromashiftTextureHandle> {
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
    this.cacheTracker.touch(url, estimateRgba8MipChainBytes(image.naturalWidth, image.naturalHeight));
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
    this.configureTexture();

    const entry = createWebGlTextureHandle(texture, width, height, cacheKey);
    this.textures.set(cacheKey, entry);
    this.cacheTracker.touch(cacheKey, estimateRgba8MipChainBytes(width, height));
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
    this.videoTextureSizes.delete(key);
  }

  /** See `TextureManager.updateVideoTexture` — same reuse/recreate policy, no mipmaps. */
  updateVideoTexture(cacheKey: string, source: HTMLVideoElement): ChromashiftTextureHandle | null {
    const width = source.videoWidth;
    const height = source.videoHeight;
    if (width === 0 || height === 0) return null;

    const gl = this.gl;
    let entry = this.textures.get(cacheKey);
    if (!entry || shouldRecreateVideoTexture(this.videoTextureSizes.get(cacheKey), width, height)) {
      if (entry) gl.deleteTexture(entry.texture);
      const texture = gl.createTexture();
      if (!texture) throw new Error('Failed to create WebGL texture.');
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      entry = createWebGlTextureHandle(texture, width, height, cacheKey);
      this.textures.set(cacheKey, entry);
      this.videoTextureSizes.set(cacheKey, videoFrameSizeKey(width, height));
      this.cacheTracker.touch(cacheKey, estimateRgba8SingleLevelBytes(width, height));
      publishTextureCacheBreadcrumbs(this.cacheTracker.entryCount, this.cacheTracker.estimatedBytes);
    }

    gl.bindTexture(gl.TEXTURE_2D, entry.texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    return entry;
  }

  /** See `ChromashiftTextureManager.releaseVideoTexture`. */
  releaseVideoTexture(cacheKey: string): void {
    this.destroyKey(cacheKey);
    publishTextureCacheBreadcrumbs(this.cacheTracker.entryCount, this.cacheTracker.estimatedBytes);
  }

  private createTextureFromSource(source: HTMLImageElement): WebGLTexture {
    const gl = this.gl;
    const texture = gl.createTexture();
    if (!texture) throw new Error('Failed to create WebGL texture.');
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    this.configureTexture();
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    return texture;
  }

  /**
   * Clamp, linear, and a full mip chain. WebGL2 mipmaps non-power-of-two
   * textures (WebGL1 couldn't), and most photos are NPOT: without the chain a
   * large image drawn small aliased, where the WebGPU path filters trilinearly.
   */
  private configureTexture(): void {
    const gl = this.gl;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.generateMipmap(gl.TEXTURE_2D);
  }
}
