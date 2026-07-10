import { advanceAnglesBy } from '../WasmEngine';
import { buildRendererState } from '../buildRendererState';
import type { ChromashiftRenderer, ExportPassMode } from '../types/RendererContracts';
import type { ChromashiftState, LayerTriple } from '../../state/types';
import {
  detectVideoCodecSupport,
  evenDimension,
  extensionForMimeType,
  pickRecorderMimeType,
} from './videoCodecs';

export interface VideoExportRequest {
  durationSec: number;
  fps: number;
  resolutionScale: number;
  includeTracers: boolean;
  passMode: ExportPassMode;
  filename: string;
  /** When true, frame 0 uses `layers.angles` from state instead of live animation angles. */
  usePresetAngles: boolean;
  signal?: AbortSignal;
  onProgress?: (frame: number, totalFrames: number) => void;
}

export interface VideoExportResult {
  blob: Blob;
  mimeType: string;
  filename: string;
  frameCount: number;
  width: number;
  height: number;
}

function yieldToMain(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

function waitForRecorderStop(recorder: MediaRecorder): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const chunks: BlobPart[] = [];
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    };
    recorder.onerror = () => reject(new Error('MediaRecorder failed during export'));
    recorder.onstop = () => {
      const type = recorder.mimeType || 'video/webm';
      resolve(new Blob(chunks, { type }));
    };
  });
}

function resolvePassMode(includeTracers: boolean, passMode: ExportPassMode): ExportPassMode {
  if (!includeTracers && passMode === 'composite') return 'layers';
  return passMode;
}

function resolveStartAngles(
  state: ChromashiftState,
  liveAngles: LayerTriple<number>,
  usePresetAngles: boolean,
): LayerTriple<number> {
  if (usePresetAngles) {
    return [...state.layers.angles] as LayerTriple<number>;
  }
  return [...liveAngles] as LayerTriple<number>;
}

/**
 * Offline frame-by-frame export encoded via MediaRecorder + manual `requestFrame()`.
 * Yields to the main thread between frames to keep the UI responsive.
 */
export async function exportVideo(
  renderer: ChromashiftRenderer,
  state: ChromashiftState,
  liveAngles: LayerTriple<number>,
  baseWidth: number,
  baseHeight: number,
  request: VideoExportRequest,
): Promise<VideoExportResult> {
  const codecSupport = detectVideoCodecSupport();
  if (!codecSupport.mediaRecorder) {
    throw new Error('This browser does not support MediaRecorder video export.');
  }

  const mimeType = pickRecorderMimeType();
  if (!mimeType) {
    throw new Error('No supported video MIME type found for MediaRecorder.');
  }

  const fps = Math.max(1, Math.min(60, Math.round(request.fps)));
  const durationSec = Math.max(0.5, request.durationSec);
  const totalFrames = Math.max(1, Math.round(durationSec * fps));
  const scale = Math.max(0.25, Math.min(2, request.resolutionScale));
  const width = evenDimension(baseWidth * scale);
  const height = evenDimension(baseHeight * scale);
  const passMode = resolvePassMode(request.includeTracers, request.passMode);
  const extensions = state.layers.extensions;
  const useWasm = state.engine.engineMode === 'wasm';

  const canvasWidth = Math.max(1, Math.round(baseWidth));
  const canvasHeight = Math.max(1, Math.round(baseHeight));

  const exportCanvas = document.createElement('canvas');
  exportCanvas.width = width;
  exportCanvas.height = height;
  const exportCtx = exportCanvas.getContext('2d', { willReadFrequently: true });
  if (!exportCtx) {
    throw new Error('Could not create 2D context for video export.');
  }

  const stream = exportCanvas.captureStream(0);
  const videoTrack = stream.getVideoTracks()[0];
  const recorder = new MediaRecorder(stream, {
    mimeType,
    videoBitsPerSecond: Math.max(4_000_000, width * height * fps * 0.12),
  });

  const stopPromise = waitForRecorderStop(recorder);
  recorder.start();

  renderer.clearPersistence();
  let angles = resolveStartAngles(state, liveAngles, request.usePresetAngles);

  try {
    for (let frame = 0; frame < totalFrames; frame += 1) {
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
        width,
        height,
        fps,
        passMode,
      });

      if (!frameResult) {
        throw new Error(`Failed to render export frame ${frame + 1}/${totalFrames}.`);
      }

      exportCtx.putImageData(
        new ImageData(frameResult.data, frameResult.width, frameResult.height),
        0,
        0,
      );

      if ('requestFrame' in videoTrack && typeof videoTrack.requestFrame === 'function') {
        videoTrack.requestFrame();
      }

      angles = advanceAnglesBy(angles, extensions, useWasm);
      request.onProgress?.(frame + 1, totalFrames);

      if (frame % 2 === 1) {
        await yieldToMain();
      }
    }
  } finally {
    recorder.stop();
    videoTrack.stop();
    stream.getTracks().forEach((track) => track.stop());
    renderer.restoreRenderSize(canvasWidth, canvasHeight);
  }

  const blob = await stopPromise;
  const ext = extensionForMimeType(mimeType);
  const baseName = request.filename.trim() || 'chromashift-export';
  const filename = baseName.includes('.') ? baseName : `${baseName}.${ext}`;

  return {
    blob,
    mimeType,
    filename,
    frameCount: totalFrames,
    width,
    height,
  };
}

export function downloadVideoExport(result: VideoExportResult): void {
  const href = URL.createObjectURL(result.blob);
  const link = document.createElement('a');
  link.href = href;
  link.download = result.filename;
  link.click();
  URL.revokeObjectURL(href);
}
