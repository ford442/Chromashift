import type { ImageEntry } from './TextureManager';
import type { ChromashiftTextureManager } from './RendererTypes';

export interface WebGLImageTexture {
  kind: 'webgl-image-texture';
  texture: WebGLTexture;
  width: number;
  height: number;
  cacheKey: string;
}

export class WebGLTextureManager implements ChromashiftTextureManager {
  private gl: WebGL2RenderingContext;
  private textures = new Map<string, WebGLImageTexture>();

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

  async loadTexture(url: string): Promise<WebGLImageTexture> {
    const cached = this.textures.get(url);
    if (cached) return cached;

    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error(`Failed to load image: ${url}`));
      img.src = url;
    });

    const texture = this.createTextureFromSource(image);
    const entry: WebGLImageTexture = {
      kind: 'webgl-image-texture',
      texture,
      width: image.naturalWidth,
      height: image.naturalHeight,
      cacheKey: url,
    };
    this.textures.set(url, entry);
    return entry;
  }

  uploadPixels(cacheKey: string, pixels: Uint8ClampedArray, width: number, height: number): WebGLImageTexture {
    const previous = this.textures.get(cacheKey);
    if (previous) this.gl.deleteTexture(previous.texture);

    const texture = this.gl.createTexture();
    if (!texture) throw new Error('Failed to create WebGL texture.');

    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    this.configureTexture(width, height);

    const entry: WebGLImageTexture = { kind: 'webgl-image-texture', texture, width, height, cacheKey };
    this.textures.set(cacheKey, entry);
    return entry;
  }

  destroy(): void {
    for (const entry of this.textures.values()) {
      this.gl.deleteTexture(entry.texture);
    }
    this.textures.clear();
  }

  /** See `TextureManager.evictExcept` — mirrors the same local-blob eviction policy for the WebGL backend. */
  evictExcept(keepUrls: Iterable<string>): void {
    const keep = new Set(keepUrls);
    for (const [url, entry] of this.textures) {
      if (url.startsWith('blob:') && !keep.has(url)) {
        this.gl.deleteTexture(entry.texture);
        this.textures.delete(url);
      }
    }
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
