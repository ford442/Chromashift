import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInitialState } from '../../state/defaults';
import type { ChromashiftRenderer, ExportFrameOptions } from '../types/RendererContracts';
import type { RendererState } from '../types/RendererState';
import type { LayerTriple } from '../../state/types';
import { exportVideo, type VideoExportRequest } from './VideoExporter';

class FakeVideoTrack {
  requestFrame = vi.fn();
  stop = vi.fn();
}

class FakeMediaRecorder {
  static instances: FakeMediaRecorder[] = [];
  static isTypeSupported(mime: string): boolean {
    return mime.startsWith('video/webm');
  }

  mimeType: string;
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onerror: (() => void) | null = null;
  onstop: (() => void) | null = null;

  constructor(_stream: unknown, options: { mimeType: string }) {
    this.mimeType = options.mimeType;
    FakeMediaRecorder.instances.push(this);
  }

  start(): void {}

  stop(): void {
    this.ondataavailable?.({ data: new Blob(['frame'], { type: this.mimeType }) });
    this.onstop?.();
  }
}

class FakeImageData {
  readonly data: Uint8ClampedArray;
  readonly width: number;
  readonly height: number;

  constructor(data: Uint8ClampedArray, width: number, height: number) {
    this.data = data;
    this.width = width;
    this.height = height;
  }
}

function makeFakeCanvas(track: FakeVideoTrack) {
  return {
    width: 0,
    height: 0,
    getContext: () => ({ putImageData: vi.fn() }),
    captureStream: () => ({
      getVideoTracks: () => [track],
      getTracks: () => [track],
    }),
  };
}

interface FakeRenderer {
  renderer: ChromashiftRenderer;
  frameAngles: LayerTriple<number>[];
  frameOptions: ExportFrameOptions[];
  frameStates: RendererState[];
  clearPersistence: ReturnType<typeof vi.fn>;
  restoreRenderSize: ReturnType<typeof vi.fn>;
}

function makeFakeRenderer(): FakeRenderer {
  const frameAngles: LayerTriple<number>[] = [];
  const frameOptions: ExportFrameOptions[] = [];
  const frameStates: RendererState[] = [];
  const clearPersistence = vi.fn();
  const restoreRenderSize = vi.fn();

  const renderer = {
    backend: 'webgpu',
    clearPersistence,
    restoreRenderSize,
    exportFrame: async (state: RendererState, options: ExportFrameOptions) => {
      frameAngles.push(
        state.layers.map((layer) => layer.angleDeg) as LayerTriple<number>,
      );
      frameOptions.push(options);
      frameStates.push(state);
      const width = options.width ?? 2;
      const height = options.height ?? 2;
      return {
        data: new Uint8ClampedArray(width * height * 4),
        width,
        height,
      };
    },
  } as unknown as ChromashiftRenderer;

  return { renderer, frameAngles, frameOptions, frameStates, clearPersistence, restoreRenderSize };
}

function makeRequest(overrides: Partial<VideoExportRequest> = {}): VideoExportRequest {
  return {
    durationSec: 1,
    fps: 10,
    resolutionScale: 1,
    includeTracers: true,
    passMode: 'composite',
    filename: 'test-export',
    usePresetAngles: true,
    ...overrides,
  };
}

describe('exportVideo (offline render loop)', () => {
  beforeEach(() => {
    FakeMediaRecorder.instances = [];
    const track = new FakeVideoTrack();
    vi.stubGlobal('MediaRecorder', FakeMediaRecorder);
    vi.stubGlobal('ImageData', FakeImageData);
    vi.stubGlobal('document', {
      createElement: (tag: string) => {
        if (tag !== 'canvas') throw new Error(`unexpected createElement(${tag})`);
        return makeFakeCanvas(track);
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders duration × fps frames, reports progress, and names the file', async () => {
    const fake = makeFakeRenderer();
    const state = createInitialState();
    const progress: number[] = [];

    const result = await exportVideo(
      fake.renderer,
      state,
      [0, 0, 0],
      640,
      480,
      makeRequest({
        durationSec: 5,
        fps: 30,
        onProgress: (frame) => progress.push(frame),
      }),
    );

    expect(fake.frameAngles).toHaveLength(150);
    expect(progress).toHaveLength(150);
    expect(progress[149]).toBe(150);
    expect(fake.clearPersistence).toHaveBeenCalledOnce();
    expect(fake.restoreRenderSize).toHaveBeenCalledWith(640, 480);
    expect(result.frameCount).toBe(150);
    expect(result.width % 2).toBe(0);
    expect(result.height % 2).toBe(0);
    expect(result.mimeType).toBe('video/webm;codecs=vp9');
    expect(result.filename).toBe('test-export.webm');
    expect(result.blob.size).toBeGreaterThan(0);
  });

  it('produces an identical angle sequence across two runs from the same preset', async () => {
    const state = createInitialState();
    state.layers.angles = [12, 34, 56];
    state.layers.extensions = [130, 230, 330];

    const runA = makeFakeRenderer();
    const runB = makeFakeRenderer();
    const request = makeRequest({ durationSec: 2, fps: 30 });

    await exportVideo(runA.renderer, state, [999, 999, 999], 320, 240, request);
    await exportVideo(runB.renderer, state, [1, 2, 3], 320, 240, request);

    // usePresetAngles ignores live angles entirely: frame 0 is the preset.
    expect(runA.frameAngles[0]).toEqual([12, 34, 56]);
    expect(runA.frameAngles).toEqual(runB.frameAngles);
    // Angles actually advance between frames.
    expect(runA.frameAngles[1]).not.toEqual(runA.frameAngles[0]);
  });

  it('starts from live angles when usePresetAngles is off', async () => {
    const fake = makeFakeRenderer();
    const state = createInitialState();
    state.layers.angles = [12, 34, 56];

    await exportVideo(
      fake.renderer,
      state,
      [100, 110, 120],
      320,
      240,
      makeRequest({ usePresetAngles: false, durationSec: 0.5, fps: 4 }),
    );

    expect(fake.frameAngles[0]).toEqual([100, 110, 120]);
  });

  it('rejects with AbortError on cancel and still restores render size', async () => {
    const fake = makeFakeRenderer();
    const state = createInitialState();
    const controller = new AbortController();

    await expect(
      exportVideo(
        fake.renderer,
        state,
        [0, 0, 0],
        320,
        240,
        makeRequest({
          durationSec: 10,
          fps: 30,
          signal: controller.signal,
          onProgress: (frame) => {
            if (frame === 5) controller.abort();
          },
        }),
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });

    expect(fake.frameAngles.length).toBeLessThan(300);
    expect(fake.restoreRenderSize).toHaveBeenCalledWith(320, 240);
  });

  it('forces layers pass and zero tracer intensity when tracers are excluded', async () => {
    const fake = makeFakeRenderer();
    const state = createInitialState();
    state.tracers.aboveIntensity = 0.8;
    state.tracers.belowIntensity = 0.6;

    await exportVideo(
      fake.renderer,
      state,
      [0, 0, 0],
      320,
      240,
      makeRequest({ includeTracers: false, passMode: 'composite', durationSec: 0.5, fps: 4 }),
    );

    expect(fake.frameOptions[0].passMode).toBe('layers');
    expect(fake.frameStates[0].tracerAboveIntensity).toBe(0);
    expect(fake.frameStates[0].tracerBelowIntensity).toBe(0);
  });
});
