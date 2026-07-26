/** Hard ceiling on cached GPU texture entries (current + reference + recent LRU). */
export const TEXTURE_CACHE_MAX_ENTRIES = 12;

/** Primary VRAM guard — estimated full mip-chain bytes for rgba8 textures. */
export const TEXTURE_CACHE_BYTE_BUDGET = 256 * 1024 * 1024;

/** Local IndexedDB library entries use `blob:` object URLs. */
export function isBlobTextureUrl(url: string): boolean {
  return url.startsWith('blob:');
}

/**
 * Sum rgba8 bytes across all mip levels (matches WebGPU full-chain upload and
 * WebGL PO2 mip generation).
 */
export function estimateRgba8MipChainBytes(width: number, height: number): number {
  let total = 0;
  let w = Math.max(1, Math.floor(width));
  let h = Math.max(1, Math.floor(height));
  while (true) {
    total += w * h * 4;
    if (w === 1 && h === 1) break;
    w = Math.max(1, Math.floor(w / 2));
    h = Math.max(1, Math.floor(h / 2));
  }
  return total;
}

/** Single-level rgba8 when mips are not generated (non-PO2 WebGL textures). */
export function estimateRgba8SingleLevelBytes(width: number, height: number): number {
  return Math.max(1, Math.floor(width)) * Math.max(1, Math.floor(height)) * 4;
}

function isPowerOfTwo(value: number): boolean {
  return value > 0 && (value & (value - 1)) === 0;
}

/** WebGL mip policy: PO2 dimensions get a full mip chain; otherwise one level. */
export function estimateWebGlTextureBytes(width: number, height: number): number {
  if (isPowerOfTwo(width) && isPowerOfTwo(height)) {
    return estimateRgba8MipChainBytes(width, height);
  }
  return estimateRgba8SingleLevelBytes(width, height);
}

/**
 * LRU tracker with per-key byte estimates. Used by TextureManager and
 * WebGLTextureManager to enforce a shared eviction policy.
 */
export class TextureCacheTracker {
  private order: string[] = [];
  private bytesByKey = new Map<string, number>();
  private totalBytes = 0;

  get entryCount(): number {
    return this.bytesByKey.size;
  }

  get estimatedBytes(): number {
    return this.totalBytes;
  }

  /** Register or refresh an entry; moves key to most-recent. */
  touch(key: string, bytes: number): void {
    const prev = this.bytesByKey.get(key);
    if (prev !== undefined) {
      this.totalBytes -= prev;
      const idx = this.order.indexOf(key);
      if (idx !== -1) this.order.splice(idx, 1);
    }
    this.bytesByKey.set(key, bytes);
    this.totalBytes += bytes;
    this.order.push(key);
  }

  /** Drop bookkeeping for a destroyed entry (caller already freed GPU memory). */
  remove(key: string): void {
    const bytes = this.bytesByKey.get(key);
    if (bytes === undefined) return;
    this.bytesByKey.delete(key);
    this.totalBytes -= bytes;
    const idx = this.order.indexOf(key);
    if (idx !== -1) this.order.splice(idx, 1);
  }

  clear(): void {
    this.order = [];
    this.bytesByKey.clear();
    this.totalBytes = 0;
  }

  bytesFor(key: string): number | undefined {
    return this.bytesByKey.get(key);
  }

  /**
   * Phase 1: evict local `blob:` keys outside `keepUrls` immediately.
   * Phase 2: LRU-evict unprotected keys until count and byte budget are satisfied.
   */
  evictToBudget(
    keepUrls: Iterable<string>,
    destroyKey: (key: string) => void,
    options?: {
      maxEntries?: number;
      byteBudget?: number;
    },
  ): void {
    const keep = new Set(keepUrls);
    const maxEntries = options?.maxEntries ?? TEXTURE_CACHE_MAX_ENTRIES;
    const byteBudget = options?.byteBudget ?? TEXTURE_CACHE_BYTE_BUDGET;

    for (const key of [...this.order]) {
      if (isBlobTextureUrl(key) && !keep.has(key)) {
        destroyKey(key);
      }
    }

    while (
      this.entryCount > maxEntries ||
      this.totalBytes > byteBudget
    ) {
      const victim = this.oldestUnprotected(keep);
      if (!victim) break;
      destroyKey(victim);
    }
  }

  private oldestUnprotected(keep: Set<string>): string | undefined {
    for (const key of this.order) {
      if (!keep.has(key)) return key;
    }
    return undefined;
  }
}
