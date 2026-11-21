import { afterEach, describe, expect, it, vi } from 'vitest';
import { measureLiveFrameLuminance } from './liveLuminance';

describe('measureLiveFrameLuminance', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns the neutral default before any frame has decoded', () => {
    const video = { videoWidth: 0, videoHeight: 0 } as HTMLVideoElement;
    expect(measureLiveFrameLuminance(video, false)).toBe(128);
  });

  it('reads a downscaled frame through a willReadFrequently 2D context, in any realm', () => {
    const getContext = vi.fn((...args: [string, CanvasRenderingContext2DSettings]) => ({
      args,
      drawImage: vi.fn(),
      // Uniform mid-grey.
      getImageData: (_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4).fill(100) }),
    }));
    class FakeOffscreenCanvas {
      width: number;
      height: number;
      getContext = getContext;
      constructor(width: number, height: number) {
        this.width = width;
        this.height = height;
      }
    }
    vi.stubGlobal('OffscreenCanvas', FakeOffscreenCanvas);
    // A transferred VideoFrame, as the render worker receives it.
    const frame = { displayWidth: 1920, displayHeight: 1080 } as VideoFrame;

    expect(measureLiveFrameLuminance(frame, false)).toBeCloseTo(100, 0);
    expect(getContext).toHaveBeenCalledWith('2d', expect.objectContaining({ willReadFrequently: true }));
  });
});
