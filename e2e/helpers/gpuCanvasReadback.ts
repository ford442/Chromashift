import type { Page } from '@playwright/test';
import { armRenderDebug } from './renderer';

/**
 * Read back what the WebGPU renderer drew into a canvas — its presentation
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
 *   read back empty. The presentation texture is what the renderer wrote.
 *
 * The copy has to happen in the task that drew the frame: once it is presented
 * the texture is gone. The renderer may not be on this page's thread at all
 * (#253: it runs in the render worker unless `?renderer=main`), so patching
 * the page's WebGPU prototypes reaches nothing. The render service does the
 * copy itself — `window.__renderDebug.readPresentedFrame(slot)`
 * (`src/engine/render/debug.ts`) — on whichever transport it runs, and the
 * page hands the raw texture rows back here to decode.
 *
 * The debug hooks are armed by `localStorage['chromashift:renderDebug']`,
 * which `installGpuCanvasReadback` sets before the app boots, so the URL stays
 * the one under test. Armed, the service configures its canvases with
 * `COPY_SRC` — usage changes what may be done with the texture, not what is
 * drawn into it.
 */

export interface CanvasFrame {
  width: number;
  height: number;
  /**
   * RGBA8, row-major, 4 bytes per pixel — BGRA canvases are swizzled, and an
   * `rgba16float` (HDR) canvas is decoded and quantised to 8 bits, clamped at
   * 1.0. Two frames whose halves agree therefore agree here too.
   */
  pixels: Buffer;
  /** The presentation format the frame was read from. */
  format: string;
}

interface RawFrame {
  width: number;
  height: number;
  format: string;
  bytesPerRow: number;
  /** The texture rows, base64. */
  bytes: string;
}

/** Must run before `page.goto`: the service reads the flag when it boots. */
export async function installGpuCanvasReadback(page: Page): Promise<void> {
  await armRenderDebug(page);
}

function halfToFloat(bits: number): number {
  const sign = bits & 0x8000 ? -1 : 1;
  const exponent = (bits >> 10) & 0x1f;
  const fraction = bits & 0x3ff;
  if (exponent === 0) return sign * 2 ** -14 * (fraction / 1024);
  if (exponent === 31) return fraction ? 0 : sign * Infinity;
  return sign * 2 ** (exponent - 15) * (1 + fraction / 1024);
}

/** Texture rows in `format` → tightly packed RGBA8. */
function decodeFrame(raw: RawFrame): CanvasFrame {
  const { width, height, format, bytesPerRow } = raw;
  const source = Buffer.from(raw.bytes, 'base64');
  const pixels = Buffer.alloc(width * height * 4);
  if (format === 'rgba16float') {
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const s = y * bytesPerRow + x * 8;
        const d = (y * width + x) * 4;
        for (let c = 0; c < 4; c += 1) {
          const value = halfToFloat(source.readUInt16LE(s + c * 2));
          pixels[d + c] = Math.max(0, Math.min(255, Math.round(value * 255)));
        }
      }
    }
  } else if (format === 'rgba8unorm' || format === 'bgra8unorm') {
    const [r, b] = format === 'bgra8unorm' ? [2, 0] : [0, 2];
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const s = y * bytesPerRow + x * 4;
        const d = (y * width + x) * 4;
        pixels[d] = source[s + r];
        pixels[d + 1] = source[s + 1];
        pixels[d + 2] = source[s + b];
        pixels[d + 3] = source[s + 3];
      }
    }
  } else {
    throw new Error(`unsupported canvas format ${format}`);
  }
  return { width, height, pixels, format };
}

/** The next frame the renderer draws into `slot`'s canvas (default the main canvas). */
export async function readGpuCanvasFrame(page: Page, slot = 'main'): Promise<CanvasFrame> {
  // The hooks are published once the transport is chosen, before the boot.
  await page.waitForFunction(() => window.__renderDebug !== undefined, undefined, { timeout: 30_000 })
    .catch(() => {
      throw new Error('window.__renderDebug never appeared: call installGpuCanvasReadback() before navigation');
    });
  const raw = await page.evaluate(async (slotId) => {
    const frame = await window.__renderDebug!.readPresentedFrame(slotId);
    const bytes = new Uint8Array(frame.bytes);
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    return { width: frame.width, height: frame.height, format: frame.format, bytesPerRow: frame.bytesPerRow, bytes: btoa(binary) };
  }, slot);
  return decodeFrame(raw);
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
