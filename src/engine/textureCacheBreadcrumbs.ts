type TextureCacheWindow = Window & {
  textureCacheSize?: number;
  textureCacheBytes?: number;
};

/** Publish texture cache stats for automation / diagnostics. */
export function publishTextureCacheBreadcrumbs(entryCount: number, estimatedBytes: number): void {
  if (typeof window === 'undefined') return;
  const target = window as TextureCacheWindow;
  target.textureCacheSize = entryCount;
  target.textureCacheBytes = estimatedBytes;
}
