import type { Page } from '@playwright/test';

/**
 * Read back what the WebGPU renderer drew into the main canvas — the swap-chain
 * texture itself, via `copyTextureToBuffer` — rather than screenshotting it.
 *
 * Two things make a screenshot the wrong instrument for a WebGPU pixel
 * comparison:
 *
 * - **It captures the page, not the canvas.** Overlay chrome painted over the
 *   canvas lands in the buffer; that is how an earlier parity assertion came to
 *   compare the UI to itself.
 * - **Headless Chromium may never present the frame.** Without the SwiftShader
 *   Vulkan flags in `playwright.config.ts` the GPU process cannot allocate the
 *   swap-chain shared image and Dawn destroys the device a few frames in
 *   (`Could not find SharedImageBackingFactory … WebgpuSwapChainTexture`), so
 *   every renderer — hand encoder and graph executor alike — "renders" black.
 *   With the flags the device survives, but the composited canvas can still
 *   read back empty. The swap-chain texture is what the renderer actually wrote.
 *
 * The copy has to happen in the same task that drew the frame: once the frame
 * is presented the texture is destroyed. So `installGpuCanvasReadback` wraps
 * `requestAnimationFrame`, and after the app's callback returns — its
 * `render()` is synchronous, so its submit has already happened — copies out
 * the main canvas's current texture if a read is waiting.
 *
 * The canvas is configured with `COPY_SRC` usage by the app itself
 * (`buildWebGpuCanvasConfiguration`), so nothing here changes what is drawn.
 */

export interface CanvasFrame {
  width: number;
  height: number;
  /** RGBA8, row-major, 4 bytes per pixel — BGRA canvases are swizzled. */
  pixels: Buffer;
}

interface RawFrame {
  width: number;
  height: number;
  rgba: string;
}

declare global {
  interface Window {
    __readMainCanvasFrame?: () => Promise<RawFrame>;
  }
}

/** Must run before `page.goto`: the wrappers have to be in place before the app configures its canvas. */
export async function installGpuCanvasReadback(page: Page): Promise<void> {
  await page.addInitScript(() => {
    if (typeof GPUCanvasContext === 'undefined') return;

    interface Waiter { resolve: (frame: RawFrame) => void; reject: (reason: string) => void }

    const devices = new WeakMap<GPUCanvasContext, GPUDevice>();
    let lost: string | null = null;
    let drawn: { context: GPUCanvasContext; texture: GPUTexture } | null = null;
    const waiting: Waiter[] = [];

    const proto = GPUCanvasContext.prototype;
    const configure = proto.configure;
    proto.configure = function (this: GPUCanvasContext, config: GPUCanvasConfiguration) {
      devices.set(this, config.device);
      void config.device.lost.then((info) => {
        lost = `${info.reason}: ${info.message}`;
      });
      return configure.call(this, config);
    };

    const getCurrentTexture = proto.getCurrentTexture;
    proto.getCurrentTexture = function (this: GPUCanvasContext) {
      const texture = getCurrentTexture.call(this);
      if (this.canvas === document.querySelector('canvas')) drawn = { context: this, texture };
      return texture;
    };

    const requestFrame = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (callback) => requestFrame((time) => {
      drawn = null;
      try {
        callback(time);
      } finally {
        if (drawn && waiting.length > 0) copyOut(drawn.context, drawn.texture, waiting.splice(0));
        drawn = null;
      }
    });

    function copyOut(context: GPUCanvasContext, texture: GPUTexture, waiters: Waiter[]): void {
      const fail = (reason: string) => waiters.forEach((w) => w.reject(reason));
      const device = devices.get(context);
      if (!device) {
        fail('the main canvas was never configured for WebGPU');
        return;
      }
      if (lost) {
        fail(`the GPU device was lost (${lost}), so nothing it drew can be read back — `
          + 'headless Chromium needs the SwiftShader Vulkan flags in playwright.config.ts');
        return;
      }
      const { width, height, format } = texture;
      if (format !== 'rgba8unorm' && format !== 'bgra8unorm') {
        fail(`unsupported canvas format ${format}`);
        return;
      }
      const bytesPerRow = Math.ceil((width * 4) / 256) * 256;
      const buffer = device.createBuffer({
        size: bytesPerRow * height,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      });
      device.pushErrorScope('validation');
      const encoder = device.createCommandEncoder();
      encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow }, [width, height, 1]);
      device.queue.submit([encoder.finish()]);
      const validation = device.popErrorScope();

      // A failed copy still maps — as zeros. Checking the error scope is what
      // keeps a broken readback from masquerading as a black frame.
      Promise.all([validation, buffer.mapAsync(GPUMapMode.READ)]).then(([error]) => {
        if (error) throw new Error(error.message);
        const mapped = new Uint8Array(buffer.getMappedRange());
        const rgba = new Uint8Array(width * height * 4);
        const [r, b] = format === 'bgra8unorm' ? [2, 0] : [0, 2];
        for (let y = 0; y < height; y += 1) {
          for (let x = 0; x < width; x += 1) {
            const s = y * bytesPerRow + x * 4;
            const d = (y * width + x) * 4;
            rgba[d] = mapped[s + r];
            rgba[d + 1] = mapped[s + 1];
            rgba[d + 2] = mapped[s + b];
            rgba[d + 3] = mapped[s + 3];
          }
        }
        buffer.unmap();
        buffer.destroy();
        let binary = '';
        for (let i = 0; i < rgba.length; i += 0x8000) {
          binary += String.fromCharCode(...rgba.subarray(i, i + 0x8000));
        }
        const frame = { width, height, rgba: btoa(binary) };
        waiters.forEach((w) => w.resolve(frame));
      }).catch((error: unknown) => {
        buffer.destroy();
        fail(`canvas readback failed: ${String(error)}`);
      });
    }

    window.__readMainCanvasFrame = () => new Promise<RawFrame>((resolve, reject) => {
      waiting.push({ resolve, reject: (reason) => reject(new Error(reason)) });
    });
  });
}

/** The next frame the renderer draws into the main canvas. */
export async function readGpuCanvasFrame(page: Page): Promise<CanvasFrame> {
  const raw = await page.evaluate(() => {
    const read = window.__readMainCanvasFrame;
    if (!read) throw new Error('installGpuCanvasReadback() was not called before navigation');
    return read();
  });
  return { width: raw.width, height: raw.height, pixels: Buffer.from(raw.rgba, 'base64') };
}

/**
 * A frame once the scene has stopped changing.
 *
 * The corpus fetch, texture upload and classification mask all land
 * asynchronously, and an image load clears the tracers — so a fixed settle delay
 * can catch them mid-accumulation. Polling until two consecutive frames are
 * byte-identical waits for the real condition; a scene that never settles fails
 * loudly instead of producing a coin-flip comparison.
 */
export async function readStableGpuCanvasFrame(
  page: Page,
  attempts = 12,
  gapMs = 300,
): Promise<CanvasFrame> {
  let previous = await readGpuCanvasFrame(page);
  for (let i = 0; i < attempts; i += 1) {
    await page.waitForTimeout(gapMs);
    const next = await readGpuCanvasFrame(page);
    if (next.pixels.equals(previous.pixels)) return next;
    previous = next;
  }
  throw new Error(
    `Canvas never settled: ${attempts + 1} frames ${gapMs}ms apart all differed. `
    + 'The scene is still animating, so no frame comparison is meaningful.',
  );
}

/** How many distinct RGB values a frame contains. 1 means a flat frame. */
export function frameDistinctColours(frame: CanvasFrame): number {
  const seen = new Set<number>();
  const { pixels } = frame;
  for (let p = 0; p < pixels.length; p += 4) {
    seen.add((pixels[p] << 16) | (pixels[p + 1] << 8) | pixels[p + 2]);
  }
  return seen.size;
}

/** Pixel-level difference, for a failure message that says *how* two frames differ. */
export function frameDifference(a: CanvasFrame, b: CanvasFrame): {
  differingPixels: number;
  maxChannelDelta: number;
} {
  if (a.width !== b.width || a.height !== b.height) {
    return { differingPixels: Math.max(a.width * a.height, b.width * b.height), maxChannelDelta: 255 };
  }
  let differingPixels = 0;
  let maxChannelDelta = 0;
  for (let p = 0; p < a.pixels.length; p += 4) {
    let pixelDiffers = false;
    for (let c = 0; c < 4; c += 1) {
      const delta = Math.abs(a.pixels[p + c] - b.pixels[p + c]);
      if (delta > 0) pixelDiffers = true;
      if (delta > maxChannelDelta) maxChannelDelta = delta;
    }
    if (pixelDiffers) differingPixels += 1;
  }
  return { differingPixels, maxChannelDelta };
}
