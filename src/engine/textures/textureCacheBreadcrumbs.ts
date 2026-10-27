import { publishDiagnostics } from '../diagnostics';

/** Publish texture cache stats for automation / diagnostics. */
export function publishTextureCacheBreadcrumbs(entryCount: number, estimatedBytes: number): void {
  publishDiagnostics({ textureCacheSize: entryCount, textureCacheBytes: estimatedBytes });
}
