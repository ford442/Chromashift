import { shouldRecreateVideoTexture, videoFrameSizeKey } from '../live/liveSourceTexture';
import { publishTextureCacheBreadcrumbs } from './textureCacheBreadcrumbs';
import {
  estimateRgba8MipChainBytes,
  estimateRgba8SingleLevelBytes,
  TextureCacheTracker,
} from './textureCachePolicy';

/** A decoded image's texture and its size, for the byte estimate. */
export interface UploadedTexture<T> {
  texture: T;
  width: number;
  height: number;
}

/**
 * The backend-agnostic half of a texture manager: textures by URL or cache
 * key, the LRU entry / byte budget, in-flight load dedupe, and the live-source
 * frame-size bookkeeping. `TextureManager` (WebGPU) and `WebGLTextureManager`
 * only create, upload and destroy textures; `T` is what each one caches.
 */
export class TextureCache<T> {
  private readonly textures = new Map<string, T>();
  private readonly tracker = new TextureCacheTracker();
  /**
   * Loads still decoding, by URL: a second `load` of the same URL while the
   * first is in flight shares it rather than decoding and uploading the image
   * again — and leaking the first texture when the second overwrote it.
   */
  private readonly pending = new Map<string, Promise<T>>();
  /** Frame size (`"WxH"`) of the texture currently cached under each live-source key. */
  private readonly videoSizes = new Map<string, string>();
  private readonly destroyTexture: (texture: T) => void;

  constructor(destroyTexture: (texture: T) => void) {
    this.destroyTexture = destroyTexture;
  }

  /**
   * The texture cached for `url` (marked most recently used), the in-flight
   * load of it, or a new load through `upload`. A failed load is not
   * remembered: the next call tries again.
   */
  load(url: string, upload: (url: string) => Promise<UploadedTexture<T>>): Promise<T> {
    const cached = this.textures.get(url);
    if (cached !== undefined) {
      const bytes = this.tracker.bytesFor(url);
      if (bytes !== undefined) this.tracker.touch(url, bytes);
      return Promise.resolve(cached);
    }
    const inFlight = this.pending.get(url);
    if (inFlight) return inFlight;

    const load = upload(url)
      .then(({ texture, width, height }) => {
        this.put(url, texture, estimateRgba8MipChainBytes(width, height));
        return texture;
      })
      .finally(() => this.pending.delete(url));
    this.pending.set(url, load);
    return load;
  }

  /**
   * Cache a mip-chained texture under `key`, destroying whatever was cached
   * there (the upscaler swaps a higher-resolution image in this way).
   */
  replace(key: string, texture: T, width: number, height: number): void {
    const previous = this.textures.get(key);
    if (previous !== undefined && previous !== texture) this.destroyTexture(previous);
    this.put(key, texture, estimateRgba8MipChainBytes(width, height));
    this.publish();
  }

  /**
   * The live-source texture under `key` for a `width`×`height` frame: the
   * cached one, or — first frame, or the resolution changed — a new one from
   * `create`, replacing the old.
   */
  video(key: string, width: number, height: number, create: () => T): T {
    const existing = this.textures.get(key);
    if (existing !== undefined && !shouldRecreateVideoTexture(this.videoSizes.get(key), width, height)) {
      return existing;
    }
    if (existing !== undefined) this.destroyTexture(existing);
    const texture = create();
    this.put(key, texture, estimateRgba8SingleLevelBytes(width, height));
    this.videoSizes.set(key, videoFrameSizeKey(width, height));
    this.publish();
    return texture;
  }

  /** Destroy and forget the texture under `key` (a live source that stopped). */
  release(key: string): void {
    this.destroyKey(key);
    this.publish();
  }

  /**
   * Evict cached textures outside the keep set. Local `blob:` URLs are destroyed
   * immediately when not kept; remote and other keys follow LRU eviction until the
   * entry cap and estimated byte budget are satisfied.
   */
  evictExcept(keepUrls: Iterable<string>): void {
    this.tracker.evictToBudget(keepUrls, (key) => this.destroyKey(key));
    this.publish();
  }

  /** Destroy every cached texture. */
  clear(): void {
    for (const texture of this.textures.values()) this.destroyTexture(texture);
    this.textures.clear();
    this.videoSizes.clear();
    this.tracker.clear();
    this.publish();
  }

  private put(key: string, texture: T, bytes: number): void {
    this.textures.set(key, texture);
    this.tracker.touch(key, bytes);
  }

  private destroyKey(key: string): void {
    const texture = this.textures.get(key);
    if (texture !== undefined) this.destroyTexture(texture);
    this.textures.delete(key);
    this.tracker.remove(key);
    this.videoSizes.delete(key);
  }

  private publish(): void {
    publishTextureCacheBreadcrumbs(this.tracker.entryCount, this.tracker.estimatedBytes);
  }
}
