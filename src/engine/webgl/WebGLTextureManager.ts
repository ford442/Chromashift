import type { ChromashiftTextureManager } from '../types/RendererContracts';
import { TextureCache, type UploadedTexture } from '../textures/TextureCache';
import {
  createWebGlTextureHandle,
  type ChromashiftTextureHandle,
  type WebGlTextureHandle,
} from '../types/TextureHandle';

export type { WebGLImageTexture, WebGlTextureHandle } from '../types/TextureHandle';

/** WebGL2 texture uploads; caching, eviction and load dedupe are `TextureCache`'s. */
export class WebGLTextureManager implements ChromashiftTextureManager {
  private gl: WebGL2RenderingContext;
  private cache: TextureCache<WebGlTextureHandle>;

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.cache = new TextureCache((entry) => gl.deleteTexture(entry.texture));
  }

  loadTexture(url: string): Promise<ChromashiftTextureHandle> {
    return this.cache.load(url, (u) => this.uploadFromUrl(u));
  }

  private async uploadFromUrl(url: string): Promise<UploadedTexture<WebGlTextureHandle>> {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error(`Failed to load image: ${url}`));
      img.src = url;
    });

    const { naturalWidth: width, naturalHeight: height } = image;
    const texture = this.createTextureFromSource(image);
    return { texture: createWebGlTextureHandle(texture, width, height, url), width, height };
  }

  uploadPixels(cacheKey: string, pixels: Uint8ClampedArray, width: number, height: number): ChromashiftTextureHandle {
    const texture = this.gl.createTexture();
    if (!texture) throw new Error('Failed to create WebGL texture.');

    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    this.configureTexture();

    const entry = createWebGlTextureHandle(texture, width, height, cacheKey);
    this.cache.replace(cacheKey, entry, width, height);
    return entry;
  }

  destroy(): void {
    this.cache.clear();
  }

  /** See `TextureCache.evictExcept`. */
  evictExcept(keepUrls: Iterable<string>): void {
    this.cache.evictExcept(keepUrls);
  }

  /** See `TextureManager.updateVideoTexture` — same reuse/recreate policy, no mipmaps. */
  updateVideoTexture(cacheKey: string, source: HTMLVideoElement): ChromashiftTextureHandle | null {
    const width = source.videoWidth;
    const height = source.videoHeight;
    if (width === 0 || height === 0) return null;

    const gl = this.gl;
    const entry = this.cache.video(cacheKey, width, height, () => {
      const texture = gl.createTexture();
      if (!texture) throw new Error('Failed to create WebGL texture.');
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      return createWebGlTextureHandle(texture, width, height, cacheKey);
    });

    gl.bindTexture(gl.TEXTURE_2D, entry.texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    return entry;
  }

  /** See `ChromashiftTextureManager.releaseVideoTexture`. */
  releaseVideoTexture(cacheKey: string): void {
    this.cache.release(cacheKey);
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
