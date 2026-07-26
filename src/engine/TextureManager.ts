/**
 * TextureManager
 *
 * Fetches image URLs from a JSON endpoint (simulating the PHP backend)
 * and uploads decoded images to GPU textures. No CPU-side pixel
 * manipulation is performed — all image data is transferred directly
 * to the GPU via `copyExternalImageToTexture`.
 */

import type { ChromashiftTextureManager } from './RendererTypes';
import { publishTextureCacheBreadcrumbs } from './textureCacheBreadcrumbs';
import {
  estimateRgba8MipChainBytes,
  TextureCacheTracker,
} from './textureCachePolicy';
import { createWebGpuTextureHandle, type ChromashiftTextureHandle } from './types/TextureHandle';

export interface ImageEntry {
  url: string;
  label?: string;
  /** Present when this entry lives in the local IndexedDB library (drag-dropped upload). */
  localId?: string;
  /** Small thumbnail object URL to show in the image strip instead of decoding the full image. */
  thumbUrl?: string;
}

export class TextureManager implements ChromashiftTextureManager {
  private device: GPUDevice;
  private textures: Map<string, GPUTexture> = new Map();
  private cacheTracker = new TextureCacheTracker();

  // Mipmap generation resources (lazy-initialised)
  private mipmapPipeline: GPURenderPipeline | null = null;
  private mipmapBGL: GPUBindGroupLayout | null = null;
  private mipmapSampler: GPUSampler | null = null;

  constructor(device: GPUDevice) {
    this.device = device;
  }

  /** Fetch a list of image entries from a JSON endpoint. */
  async fetchImageList(endpoint: string, signal?: AbortSignal): Promise<ImageEntry[]> {
    const response = await fetch(endpoint, { signal });
    if (!response.ok) {
      throw new Error(`Failed to fetch image list from ${endpoint}: ${response.statusText}`);
    }
    const data: ImageEntry[] = await response.json();
    return data;
  }

  /**
   * Load an image from a URL and upload it to a GPU texture with full mip chain.
   * Returns the cached texture if already loaded.
   */
  async loadTexture(url: string): Promise<ChromashiftTextureHandle> {
    const cached = this.textures.get(url);
    if (cached) {
      const bytes = this.cacheTracker.bytesFor(url);
      if (bytes !== undefined) this.cacheTracker.touch(url, bytes);
      return createWebGpuTextureHandle(cached);
    }

    const image = new Image();
    image.crossOrigin = 'anonymous';

    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error(`Failed to load image: ${url}`));
      image.src = url;
    });

    const imageBitmap = await createImageBitmap(image);
    // Use srgb format so that standard photo/JPEG/PNG content (which is encoded
    // in sRGB) is automatically decoded to linear RGB on textureSample. This
    // gives correct luminance (BT.709) calculations and more accurate colour
    // mixing in the layer + persistence passes. Prevents gamma-related banding
    // and washed-out or crushed colours in the separation.
    const mipLevelCount = Math.floor(Math.log2(Math.max(imageBitmap.width, imageBitmap.height))) + 1;
    const texture = this.device.createTexture({
      size: [imageBitmap.width, imageBitmap.height, 1],
      format: 'rgba8unorm-srgb',
      mipLevelCount,
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
    // Downsample mip 0 into all subsequent levels so the renderer's
    // mipmapFilter:'linear' sampler can do true trilinear filtering.
    // Each level is rendered from the previous in linear light (srgb
    // textures decode on sample and re-encode on write), which gives
    // perceptually correct results without gamma-space banding.
    this.generateMipmaps(texture, mipLevelCount);
    this.textures.set(url, texture);
    this.cacheTracker.touch(url, estimateRgba8MipChainBytes(imageBitmap.width, imageBitmap.height));
    return createWebGpuTextureHandle(texture);
  }

  /** Destroy all managed GPU textures and free GPU memory. */
  destroy(): void {
    for (const texture of this.textures.values()) {
      texture.destroy();
    }
    this.textures.clear();
    this.cacheTracker.clear();
    publishTextureCacheBreadcrumbs(0, 0);
  }

  /**
   * Evict cached textures outside the keep set. Local `blob:` URLs are destroyed
   * immediately when not kept; remote and other keys follow LRU eviction until the
   * entry cap and estimated mip-chain byte budget are satisfied.
   */
  evictExcept(keepUrls: Iterable<string>): void {
    this.cacheTracker.evictToBudget(keepUrls, (key) => this.destroyKey(key));
    publishTextureCacheBreadcrumbs(this.cacheTracker.entryCount, this.cacheTracker.estimatedBytes);
  }

  private destroyKey(key: string): void {
    const texture = this.textures.get(key);
    if (texture) texture.destroy();
    this.textures.delete(key);
    this.cacheTracker.remove(key);
  }

  /**
   * Upload raw RGBA8 pixels into a new GPUTexture and register it under
   * `cacheKey` (replacing any previous texture cached under that key). Used
   * by the upscaler flow to swap in a higher-resolution version of an image.
   */
  uploadPixels(cacheKey: string, pixels: Uint8ClampedArray, width: number, height: number): ChromashiftTextureHandle {
    const prev = this.textures.get(cacheKey);
    if (prev) {
      prev.destroy();
      this.cacheTracker.remove(cacheKey);
    }

    // srgb for upscaled pixels too (they come from 2D canvas which is sRGB).
    // See comment above in loadTexture for why srgb improves colour fidelity.
    const mipLevelCount = Math.floor(Math.log2(Math.max(width, height))) + 1;
    const texture = this.device.createTexture({
      size: [width, height, 1],
      format: 'rgba8unorm-srgb',
      mipLevelCount,
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
    this.generateMipmaps(texture, mipLevelCount);
    this.textures.set(cacheKey, texture);
    this.cacheTracker.touch(cacheKey, estimateRgba8MipChainBytes(width, height));
    publishTextureCacheBreadcrumbs(this.cacheTracker.entryCount, this.cacheTracker.estimatedBytes);
    return createWebGpuTextureHandle(texture);
  }

  // ─── Mipmap generation ────────────────────────────────────────────────────────

  private ensureMipmapPipeline(): void {
    if (this.mipmapPipeline) return;
    const device = this.device;

    const code = /* wgsl */`
struct VO { @builtin(position) pos: vec4<f32>, @location(0) uv: vec2<f32> };
const POS = array<vec2<f32>,6>(vec2(-1.,-1.),vec2(1.,-1.),vec2(-1.,1.),vec2(-1.,1.),vec2(1.,-1.),vec2(1.,1.));
const UV  = array<vec2<f32>,6>(vec2(0.,1.),vec2(1.,1.),vec2(0.,0.),vec2(0.,0.),vec2(1.,1.),vec2(1.,0.));
@vertex fn vs(@builtin(vertex_index) vi: u32) -> VO {
  var o: VO; o.pos = vec4(POS[vi],0.,1.); o.uv = UV[vi]; return o;
}
@group(0) @binding(0) var s: sampler;
@group(0) @binding(1) var t: texture_2d<f32>;
@fragment fn fs(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
  return textureSample(t, s, uv);
}`;

    const module = device.createShaderModule({ code });
    this.mipmapBGL = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
      ],
    });
    this.mipmapSampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
    this.mipmapPipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.mipmapBGL] }),
      vertex: { module, entryPoint: 'vs' },
      fragment: { module, entryPoint: 'fs', targets: [{ format: 'rgba8unorm-srgb' }] },
      primitive: { topology: 'triangle-list' },
    });
  }

  private generateMipmaps(texture: GPUTexture, mipLevelCount: number): void {
    if (mipLevelCount <= 1) return;
    this.ensureMipmapPipeline();
    const enc = this.device.createCommandEncoder();
    for (let level = 1; level < mipLevelCount; level++) {
      const srcView = texture.createView({ baseMipLevel: level - 1, mipLevelCount: 1 });
      const dstView = texture.createView({ baseMipLevel: level, mipLevelCount: 1 });
      const bg = this.device.createBindGroup({
        layout: this.mipmapBGL!,
        entries: [
          { binding: 0, resource: this.mipmapSampler! },
          { binding: 1, resource: srcView },
        ],
      });
      const pass = enc.beginRenderPass({
        colorAttachments: [{
          view: dstView, loadOp: 'clear', storeOp: 'store',
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
        }],
      });
      pass.setPipeline(this.mipmapPipeline!);
      pass.setBindGroup(0, bg);
      pass.draw(6);
      pass.end();
    }
    this.device.queue.submit([enc.finish()]);
  }
}
