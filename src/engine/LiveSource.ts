/**
 * LiveSourceManager
 *
 * Owns a single `HTMLVideoElement` fed by either a `MediaStream` (camera /
 * screen share) or a looping local video file, so the same element can be
 * handed to `TextureManager.updateVideoTexture` / `WebGLTextureManager.updateVideoTexture`
 * every frame. Only one source is active at a time — starting a new one tears
 * down whatever was running first.
 */

import { computeAverageLuminanceStridedWith } from './WasmEngine';

export type LiveSourceKind = 'camera' | 'screen' | 'video-file';

export interface LiveSourceStartResult {
  label: string;
}

export class LiveSourceManager {
  readonly element: HTMLVideoElement;
  private stream: MediaStream | null = null;
  private objectUrl: string | null = null;
  private _kind: LiveSourceKind | null = null;
  /** Invoked when the underlying track/stream ends on its own (e.g. the user stops screen-share from the browser chrome). */
  private readonly onEnded?: () => void;

  constructor(onEnded?: () => void) {
    this.onEnded = onEnded;
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    this.element = video;
  }

  get kind(): LiveSourceKind | null {
    return this._kind;
  }

  get active(): boolean {
    return this._kind !== null;
  }

  /** Current decoded frame size, or `null` before the first frame has arrived. */
  get frameSize(): { width: number; height: number } | null {
    const { videoWidth, videoHeight } = this.element;
    if (!videoWidth || !videoHeight) return null;
    return { width: videoWidth, height: videoHeight };
  }

  async startCamera(constraints?: MediaStreamConstraints): Promise<LiveSourceStartResult> {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('Camera capture is not supported in this browser.');
    }
    this.teardown();
    const stream = await navigator.mediaDevices.getUserMedia(
      constraints ?? { video: { facingMode: 'user' }, audio: false },
    );
    return this.attachStream(stream, 'camera', 'Camera');
  }

  async startScreenShare(): Promise<LiveSourceStartResult> {
    if (!navigator.mediaDevices?.getDisplayMedia) {
      throw new Error('Screen capture is not supported in this browser.');
    }
    this.teardown();
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    return this.attachStream(stream, 'screen', 'Screen Share');
  }

  async loadVideoFile(file: File): Promise<LiveSourceStartResult> {
    this.teardown();
    const url = URL.createObjectURL(file);
    this.objectUrl = url;
    this.element.srcObject = null;
    this.element.loop = true;
    this.element.src = url;
    try {
      await this.element.play();
    } catch {
      // Autoplay can reject before the first user gesture settles; the video
      // is still loaded and will start once the browser allows it.
    }
    this._kind = 'video-file';
    return { label: file.name };
  }

  /** Stop capture/playback and release the underlying stream or object URL. */
  stop(): void {
    this.teardown();
    this._kind = null;
  }

  private async attachStream(
    stream: MediaStream,
    kind: LiveSourceKind,
    fallbackLabel: string,
  ): Promise<LiveSourceStartResult> {
    this.stream = stream;
    this.element.loop = false;
    this.element.srcObject = stream;
    try {
      await this.element.play();
    } catch {
      // Same rationale as loadVideoFile — element is muted so this should
      // rarely reject, but don't fail source acquisition over it.
    }
    this._kind = kind;
    const track = stream.getVideoTracks()[0];
    track?.addEventListener('ended', () => this.onEnded?.());
    return { label: track?.label || fallbackLabel };
  }

  private teardown(): void {
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    this.stream = null;
    if (this.objectUrl) {
      URL.revokeObjectURL(this.objectUrl);
      this.objectUrl = null;
    }
    this.element.pause();
    this.element.removeAttribute('src');
    this.element.srcObject = null;
    this.element.load();
  }
}

/**
 * Average ITU-R BT.709 luminance of the current video frame, downsampled to
 * ≤256px on the longest edge via an offscreen 2D canvas. Mirrors
 * `computeImageAverageLuminanceWith` in `WasmEngine.ts` but for a video
 * element (which has `videoWidth`/`videoHeight` instead of `naturalWidth`/
 * `naturalHeight` and can't be measured with `createImageBitmap` cheaply on
 * every frame).
 */
export function computeVideoAverageLuminance(video: HTMLVideoElement, useWasm: boolean): number {
  const width = video.videoWidth;
  const height = video.videoHeight;
  if (!width || !height) return 128;

  const canvas = document.createElement('canvas');
  const maxDim = 256;
  const scale = Math.min(1, maxDim / Math.max(width, height));
  canvas.width = Math.max(1, Math.floor(width * scale));
  canvas.height = Math.max(1, Math.floor(height * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) return 128;

  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return computeAverageLuminanceStridedWith(data, canvas.width, canvas.height, 1, useWasm);
}
