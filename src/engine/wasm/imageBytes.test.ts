import { afterEach, describe, expect, it, vi } from 'vitest';
import { getImageBytes, getImageDataAtNaturalSize } from './imageBytes';

interface FakeCanvas {
  width: number;
  height: number;
  getContext: (kind: string) => unknown;
}

function stubDocumentCanvas(onCreate: (canvas: FakeCanvas) => void): { createCount: number } {
  const stats = { createCount: 0 };
  vi.stubGlobal('document', {
    createElement: (tag: string) => {
      if (tag !== 'canvas') throw new Error(`unexpected createElement(${tag})`);
      stats.createCount += 1;
      const canvas: FakeCanvas = {
        width: 0,
        height: 0,
        getContext: () => ({
          drawImage: vi.fn(),
          getImageData: (_x: number, _y: number, w: number, h: number) => ({
            data: new Uint8ClampedArray(w * h * 4).fill(7),
            width: w,
            height: h,
          }),
        }),
      };
      onCreate(canvas);
      return canvas;
    },
  });
  return stats;
}

function image(naturalWidth: number, naturalHeight: number): HTMLImageElement {
  return { naturalWidth, naturalHeight, width: naturalWidth, height: naturalHeight } as HTMLImageElement;
}

function bitmap(width: number, height: number): ImageBitmap {
  return { width, height, close: vi.fn() } as unknown as ImageBitmap;
}

describe('imageBytes canvas reuse', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reuses one canvas across repeated calls on the same document', () => {
    const created: FakeCanvas[] = [];
    const stats = stubDocumentCanvas((c) => created.push(c));

    getImageDataAtNaturalSize(image(64, 64));
    getImageDataAtNaturalSize(image(128, 32));
    getImageBytes(image(512, 512));

    expect(stats.createCount).toBe(1);
  });

  it('resizes the shared canvas to fit each source', () => {
    let lastCanvas: FakeCanvas | null = null;
    stubDocumentCanvas((c) => { lastCanvas = c; });

    getImageDataAtNaturalSize(image(300, 150));
    expect(lastCanvas).not.toBeNull();
    expect(lastCanvas!.width).toBe(300);
    expect(lastCanvas!.height).toBe(150);

    getImageDataAtNaturalSize(image(40, 20));
    expect(lastCanvas!.width).toBe(40);
    expect(lastCanvas!.height).toBe(20);
  });

  it('creates a fresh canvas when the global document is swapped (test isolation)', () => {
    const first = stubDocumentCanvas(() => {});
    getImageDataAtNaturalSize(image(16, 16));
    expect(first.createCount).toBe(1);

    const second = stubDocumentCanvas(() => {});
    getImageDataAtNaturalSize(image(16, 16));
    expect(second.createCount).toBe(1);
  });

  it('downscales to <=256px on the longest edge for getImageBytes', () => {
    let lastCanvas: FakeCanvas | null = null;
    stubDocumentCanvas((c) => { lastCanvas = c; });

    const bytes = getImageBytes(image(1024, 512));
    expect(lastCanvas!.width).toBe(256);
    expect(lastCanvas!.height).toBe(128);
    expect(bytes).not.toBeNull();
  });

  it('accepts an ImageBitmap source (the analysis-worker call shape)', () => {
    let lastCanvas: FakeCanvas | null = null;
    stubDocumentCanvas((c) => { lastCanvas = c; });

    const data = getImageDataAtNaturalSize(bitmap(48, 32));
    expect(lastCanvas!.width).toBe(48);
    expect(lastCanvas!.height).toBe(32);
    expect(data?.width).toBe(48);
    expect(data?.height).toBe(32);
  });

  it('falls back to OffscreenCanvas when there is no document (worker context)', () => {
    vi.stubGlobal('document', undefined);
    class FakeOffscreenCanvas {
      width: number;
      height: number;
      constructor(width: number, height: number) {
        this.width = width;
        this.height = height;
      }
      getContext() {
        return {
          drawImage: vi.fn(),
          getImageData: (_x: number, _y: number, w: number, h: number) => ({
            data: new Uint8ClampedArray(w * h * 4),
            width: w,
            height: h,
          }),
        };
      }
    }
    vi.stubGlobal('OffscreenCanvas', FakeOffscreenCanvas);

    const data = getImageDataAtNaturalSize(bitmap(64, 64));
    expect(data?.width).toBe(64);
    expect(data?.height).toBe(64);
  });
});
