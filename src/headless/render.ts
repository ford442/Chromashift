import { exportVideoFrameLoop } from '../engine/videoExport/exportVideoFrameLoop';
import { computeExportDimensions } from '../engine/videoExport/exportVideoUtils';
import type { VideoExportRequest } from '../engine/videoExport/VideoExporter';
import type { ExportFrameResult, ExportPassMode } from '../engine/types/RendererContracts';
import type { ChromashiftState } from '../state/types';
import type { HeadlessSession } from './session';

export interface RenderClipOptions {
  width: number;
  height: number;
  fps: number;
  frames: number;
  passMode?: ExportPassMode;
  includeTracers?: boolean;
}

export interface RenderedFrame {
  index: number;
  frame: ExportFrameResult;
}

/**
 * Render a clip of the session's source: the browser's video export loop
 * (`exportVideoFrameLoop`) over `renderer.exportFrame`, unchanged — the same
 * offline frame clock, angle stepping, persistence reset and SDR export
 * variant. Frames come back as RGBA8.
 *
 * Starts from the settings' own angles (the export panel's "use preset
 * angles"), since a headless session has no live animation to start from.
 */
export async function* renderClip(
  session: HeadlessSession,
  state: ChromashiftState,
  options: RenderClipOptions,
): AsyncGenerator<RenderedFrame> {
  const request: VideoExportRequest = {
    ...state.ui.videoExportSettings,
    durationSec: options.frames / options.fps,
    fps: options.fps,
    resolutionScale: 1,
    includeTracers: options.includeTracers ?? true,
    passMode: options.passMode ?? 'composite',
    usePresetAngles: true,
  };
  const dims = {
    ...computeExportDimensions(state, options.width, options.height, request),
    // An exact frame count: the export panel's half-second floor is a UI limit.
    totalFrames: Math.max(1, Math.floor(options.frames)),
  };

  const { renderer } = session;
  renderer.clearPersistence();
  try {
    for await (const { frameResult, frameIndex } of exportVideoFrameLoop(
      renderer, state, [...state.layers.angles], request, dims,
    )) {
      yield { index: frameIndex, frame: frameResult };
    }
  } finally {
    renderer.restoreRenderSize(dims.canvasWidth, dims.canvasHeight);
  }
}

/** The last frame of a clip — a still that has let the tracers accumulate. */
export async function renderStill(
  session: HeadlessSession,
  state: ChromashiftState,
  options: RenderClipOptions,
): Promise<ExportFrameResult> {
  let last: ExportFrameResult | null = null;
  for await (const { frame } of renderClip(session, state, options)) last = frame;
  if (!last) throw new Error('No frame rendered.');
  return last;
}
