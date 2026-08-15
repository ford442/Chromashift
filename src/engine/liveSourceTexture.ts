/**
 * Shared helpers for uploading a live video frame (camera / screen-share /
 * looping video file) into a reused GPU texture, one per texture manager
 * backend. Kept separate from `TextureManager` / `WebGLTextureManager` so the
 * recreate-on-resize decision is a pure function that can be unit tested
 * without a GPU device or WebGL context.
 */

/** Cache key both texture managers use for the single live-source texture slot. */
export const LIVE_SOURCE_CACHE_KEY = '__live-source__';

export function videoFrameSizeKey(width: number, height: number): string {
  return `${width}x${height}`;
}

/**
 * Whether the backing texture must be destroyed and recreated for a new
 * frame size. `undefined` (no texture yet) always requires creation.
 */
export function shouldRecreateVideoTexture(
  previousSizeKey: string | undefined,
  width: number,
  height: number,
): boolean {
  return previousSizeKey !== videoFrameSizeKey(width, height);
}
