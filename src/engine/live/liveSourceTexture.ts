/**
 * Shared helpers for uploading a live video frame (camera / screen-share /
 * looping video file) into a reused GPU texture, one per texture manager
 * backend. Kept separate from `TextureManager` / `WebGLTextureManager` so the
 * recreate-on-resize decision is a pure function that can be unit tested
 * without a GPU device or WebGL context.
 */

/**
 * One live frame, as a texture manager uploads it: the `<video>` itself on
 * the page, or — across the render worker's boundary, where an element cannot
 * go — a `VideoFrame` or `ImageBitmap` captured from it (#253).
 */
export type LiveFrameSource = HTMLVideoElement | VideoFrame | ImageBitmap;

/** A live frame's size in pixels; 0×0 while a video has no decoded frame yet. */
export function liveFrameSize(source: LiveFrameSource): { width: number; height: number } {
  if ('videoWidth' in source) return { width: source.videoWidth, height: source.videoHeight };
  if ('displayWidth' in source) return { width: source.displayWidth, height: source.displayHeight };
  return { width: source.width, height: source.height };
}

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
