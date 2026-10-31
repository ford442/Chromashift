import { buildRendererState } from '../buildRendererState';
import { FrameClock } from '../frame/FrameClock';
import { advanceAngles } from '../math/rotation';
import type { ChromashiftRenderer, ExportFrameResult } from '../types/RendererContracts';
import type { ChromashiftState } from '../../state/types';
import type { VideoExportRequest } from './VideoExporter';
import {
  resolveStartAngles,
  yieldToMain,
  type ExportDimensions,
} from './exportVideoUtils';

export interface ExportFrameYield {
  frameResult: ExportFrameResult;
  frameIndex: number;
}

/**
 * Deterministic offline render loop shared by MediaRecorder and WebCodecs export paths.
 * Caller must call `renderer.clearPersistence()` before iterating and
 * `renderer.restoreRenderSize()` in a `finally` block.
 *
 * Each frame is one offline {@link FrameClock.step} of `1000 / fps` ms: the
 * frame is rendered by a `render`-phase task, after whatever `input` /
 * `sources` / `modulate` tasks the live session has registered — the same
 * phases, in the same order, as a live frame.
 */
export async function* exportVideoFrameLoop(
  renderer: ChromashiftRenderer,
  state: ChromashiftState,
  liveAngles: number[],
  request: VideoExportRequest,
  dims: ExportDimensions,
): AsyncGenerator<ExportFrameYield> {
  let angles = resolveStartAngles(state, liveAngles, request.usePresetAngles);
  let frameResult: ExportFrameResult | null = null;

  const clock = request.clock ?? new FrameClock();
  const exitOffline = clock.enterOffline(typeof performance !== 'undefined' ? performance.now() : 0);
  const unregister = clock.register('render', async () => {
    const exportState = buildRendererState(state, angles, {
      paused: false,
      mainViewMode: 0,
      viewportQuarterZoom: false,
      viewportHalfOverlay: false,
      diagnosticsMode: false,
      ...(request.includeTracers
        ? {}
        : { tracerAboveIntensity: 0, tracerBelowIntensity: 0 }),
    });
    frameResult = await renderer.exportFrame(exportState, {
      width: dims.width,
      height: dims.height,
      fps: dims.fps,
      passMode: dims.passMode,
    });
  }, 'video-export');

  try {
    for (let frame = 0; frame < dims.totalFrames; frame += 1) {
      if (request.signal?.aborted) {
        throw new DOMException('Export cancelled', 'AbortError');
      }

      frameResult = null;
      await clock.step(1000 / dims.fps);
      if (!frameResult) {
        throw new Error(`Failed to render export frame ${frame + 1}/${dims.totalFrames}.`);
      }

      yield { frameResult, frameIndex: frame };

      angles = advanceAngles(angles, state.layers.extensions, dims.fps);
      request.onProgress?.(frame + 1, dims.totalFrames);

      if (frame % 2 === 1) {
        await yieldToMain();
      }
    }
  } finally {
    unregister();
    exitOffline();
  }
}
