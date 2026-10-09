import type { RenderTarget } from './resources';

/**
 * Read a rendered target without stalling the animation thread.
 *
 * `readPixels` into client memory flushes every WebGL command still queued on
 * the context — including the full-resolution layer and tracer passes — and
 * the wait shows up as CPU frame time. Packing into a `PIXEL_PACK_BUFFER` and
 * mapping it only after a fence has signaled keeps that wait off the frame
 * that issued the draws.
 */
export class PixelPackRead {
  private readonly gl: WebGL2RenderingContext;
  private pbo: WebGLBuffer | null = null;
  private fence: WebGLSync | null = null;
  private width = 0;
  private height = 0;
  private pending = false;

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
  }

  get busy(): boolean {
    return this.pending;
  }

  /** Queue a pack of `target`. Replaces an unread pack. */
  start(target: RenderTarget, width: number, height: number): void {
    const gl = this.gl;
    this.cancel();
    if (!this.pbo) {
      const buffer = gl.createBuffer();
      if (!buffer) throw new Error('Failed to create a WebGL pixel-pack buffer.');
      this.pbo = buffer;
    }
    const bytes = width * height * 4;
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.pbo);
    if (this.width !== width || this.height !== height) {
      gl.bufferData(gl.PIXEL_PACK_BUFFER, bytes, gl.STREAM_READ);
      this.width = width;
      this.height = height;
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, 0);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    const fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    gl.flush();
    if (!fence) {
      this.pending = false;
      return;
    }
    this.fence = fence;
    this.pending = true;
  }

  /**
   * Map the pack once the fence has signaled.
   * Returns null while the GPU still owns the buffer — never blocks.
   */
  poll(): Uint8ClampedArray<ArrayBuffer> | null {
    if (!this.pending || !this.fence || !this.pbo) return null;
    const gl = this.gl;
    const status = gl.clientWaitSync(this.fence, 0, 0);
    if (status === gl.WAIT_FAILED) {
      this.cancel();
      return null;
    }
    if (status !== gl.ALREADY_SIGNALED && status !== gl.CONDITION_SATISFIED) return null;
    gl.deleteSync(this.fence);
    this.fence = null;
    this.pending = false;
    const data = new Uint8Array(this.width * this.height * 4);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.pbo);
    gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, data);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    return flipRgbaRows(data, this.width, this.height);
  }

  /** Resolve the in-flight pack, yielding between polls so input can run. */
  async wait(): Promise<Uint8ClampedArray<ArrayBuffer> | null> {
    if (!this.pending) return null;
    const maxFrames = 120;
    for (let frame = 0; frame < maxFrames; frame += 1) {
      const pixels = this.poll();
      if (pixels) return pixels;
      await nextFrame();
    }
    this.cancel();
    return null;
  }

  cancel(): void {
    const gl = this.gl;
    if (this.fence) {
      gl.deleteSync(this.fence);
      this.fence = null;
    }
    this.pending = false;
  }

  destroy(): void {
    this.cancel();
    if (this.pbo) {
      this.gl.deleteBuffer(this.pbo);
      this.pbo = null;
    }
    this.width = 0;
    this.height = 0;
  }
}

export function flipRgbaRows(
  data: Uint8Array,
  width: number,
  height: number,
): Uint8ClampedArray<ArrayBuffer> {
  const flipped = new Uint8ClampedArray(width * height * 4);
  const rowBytes = width * 4;
  for (let y = 0; y < height; y += 1) {
    const srcOffset = (height - 1 - y) * rowBytes;
    flipped.set(data.subarray(srcOffset, srcOffset + rowBytes), y * rowBytes);
  }
  return flipped;
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => resolve());
    else setTimeout(resolve, 0);
  });
}
