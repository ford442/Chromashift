import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  computeAverageLuminanceStridedWith,
  computeImageAverageLuminanceWith,
} from './WasmEngine';

function buildGoldenRgba(width: number, height: number): Uint8ClampedArray {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      const v = Math.round((x / Math.max(1, width - 1)) * 255);
      const band = (x + y) % 3;
      data[i] = band === 0 ? v : 32;
      data[i + 1] = band === 1 ? v : 64;
      data[i + 2] = band === 2 ? v : 96;
      data[i + 3] = 255;
    }
  }
  return data;
}

function bt709Luminance(r: number, g: number, b: number): number {
  return r * 0.2126 + g * 0.7152 + b * 0.0722;
}

function stridedAverageReference(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  stride: number,
): number {
  const safeStride = Math.max(1, stride);
  let sum = 0;
  let n = 0;
  for (let y = 0; y < height; y += safeStride) {
    for (let x = 0; x < width; x += safeStride) {
      const o = (y * width + x) * 4;
      sum += bt709Luminance(pixels[o], pixels[o + 1], pixels[o + 2]);
      n += 1;
    }
  }
  return n === 0 ? 128 : sum / n;
}

function fullScanReference(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
): number {
  return stridedAverageReference(pixels, width, height, 1);
}

/**
 * A canvas whose `drawImage` copies source rows 1:1 out of `data` (the
 * image's pixels) and whose `getImageData` reads back what was drawn — enough
 * for both the downscale path (drawn at full size) and the strided-row path.
 */
function stubCanvasImageData(data: Uint8ClampedArray, width: number, height: number): { readBytes: number } {
  const stats = { readBytes: 0 };
  vi.stubGlobal('document', {
    createElement: (tag: string) => {
      if (tag !== 'canvas') {
        throw new Error(`unexpected createElement(${tag})`);
      }
      let pixels = new Uint8ClampedArray(0);
      const canvas = {
        width: 0,
        height: 0,
        getContext: () => ({
          imageSmoothingEnabled: true,
          drawImage: (_src: unknown, ...args: number[]) => {
            if (pixels.length !== canvas.width * canvas.height * 4) {
              pixels = new Uint8ClampedArray(canvas.width * canvas.height * 4);
            }
            // drawImage(src, dx, dy, dw, dh) draws the whole image; the 9-arg
            // form copies the source rect (sx, sy, sw, sh) to (dx, dy).
            const [sx, sy, sw, sh, dx, dy] = args.length === 8 ? args : [0, 0, width, height, 0, 0];
            for (let row = 0; row < sh; row++) {
              const from = ((sy + row) * width + sx) * 4;
              pixels.set(data.subarray(from, from + sw * 4), ((dy + row) * canvas.width + dx) * 4);
            }
          },
          getImageData: (_x: number, _y: number, w: number, h: number) => {
            stats.readBytes += w * h * 4;
            return { data: pixels.slice(0, w * h * 4), width: w, height: h };
          },
        }),
      };
      return canvas;
    },
  });
  return stats;
}

describe('computeAverageLuminanceStridedWith', () => {
  const width = 64;
  const height = 64;
  const pixels = buildGoldenRgba(width, height);

  it('matches full-scan reference at stride 1 (TS path)', () => {
    const expected = fullScanReference(pixels, width, height);
    const actual = computeAverageLuminanceStridedWith(pixels, width, height, 1, false);
    expect(actual).toBeCloseTo(expected, 4);
  });

  it.each([2, 4, 8])('matches strided reference at stride %i (TS path)', (stride) => {
    const expected = stridedAverageReference(pixels, width, height, stride);
    const actual = computeAverageLuminanceStridedWith(pixels, width, height, stride, false);
    expect(actual).toBeCloseTo(expected, 4);
  });

  it('refuses a buffer shorter than width × height RGBA', () => {
    expect(() => computeAverageLuminanceStridedWith(pixels.subarray(4), width, height, 1, false))
      .toThrow(RangeError);
  });
});

describe('computeImageAverageLuminanceWith', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('uses strided full-resolution sampling for large images', () => {
    const width = 512;
    const height = 384;
    const pixels = buildGoldenRgba(width, height);
    const stride = Math.max(1, Math.floor(Math.max(width, height) / 256));
    const expected = stridedAverageReference(pixels, width, height, stride);

    const stats = stubCanvasImageData(pixels, width, height);
    const image = {
      naturalWidth: width,
      naturalHeight: height,
      width,
      height,
    } as HTMLImageElement;

    const actual = computeImageAverageLuminanceWith(image, false);
    expect(actual).toBeCloseTo(expected, 4);
    // Only the sampled rows leave the canvas, not the whole frame.
    expect(stats.readBytes).toBe(width * Math.ceil(height / stride) * 4);
  });

  it('uses downscaled path for small images', () => {
    const width = 128;
    const height = 96;
    const pixels = buildGoldenRgba(width, height);
    const expected = fullScanReference(pixels, width, height);

    stubCanvasImageData(pixels, width, height);
    const image = {
      naturalWidth: width,
      naturalHeight: height,
      width,
      height,
    } as HTMLImageElement;

    const actual = computeImageAverageLuminanceWith(image, false);
    expect(actual).toBeCloseTo(expected, 4);
  });
});
