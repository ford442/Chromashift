import { advanceAnglesBy } from '../WasmEngine';
import { buildRendererState } from '../buildRendererState';
import type { ChromashiftRenderer, ExportFrameResult } from '../types/RendererContracts';
import type { ChromashiftState, LayerTriple } from '../../state/types';
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
 */
export async function* exportVideoFrameLoop(
  renderer: ChromashiftRenderer,
  state: ChromashiftState,
  liveAngles: LayerTriple<number>,
  request: VideoExportRequest,
  dims: ExportDimensions,
): AsyncGenerator<ExportFrameYield> {
  let angles = resolveStartAngles(state, liveAngles, request.usePresetAngles);

  for (let frame = 0; frame < dims.totalFrames; frame += 1) {
    if (request.signal?.aborted) {
      throw new DOMException('Export cancelled', 'AbortError');
    }

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

    const frameResult = await renderer.exportFrame(exportState, {
      width: dims.width,
      height: dims.height,
      fps: dims.fps,
      passMode: dims.passMode,
    });

    if (!frameResult) {
      throw new Error(`Failed to render export frame ${frame + 1}/${dims.totalFrames}.`);
    }

    yield { frameResult, frameIndex: frame };

    angles = advanceAnglesBy(angles, dims.frameSteps, dims.useWasm);
    request.onProgress?.(frame + 1, dims.totalFrames);

    if (frame % 2 === 1) {
      await yieldToMain();
    }
  }
}
