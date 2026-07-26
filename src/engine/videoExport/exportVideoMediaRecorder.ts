import type { ChromashiftRenderer } from '../types/RendererContracts';
import type { ChromashiftState, LayerTriple } from '../../state/types';
import { exportVideoFrameLoop } from './exportVideoFrameLoop';
import {
  buildExportFilename,
  computeExportDimensions,
} from './exportVideoUtils';
import { extensionForMimeType, pickRecorderMimeType } from './videoCodecs';
import type { VideoExportRequest, VideoExportResult } from './VideoExporter';

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

/**
 * Offline frame-by-frame export via MediaRecorder + manual `requestFrame()`.
 */
export async function exportVideoMediaRecorder(
  renderer: ChromashiftRenderer,
  state: ChromashiftState,
  liveAngles: LayerTriple<number>,
  baseWidth: number,
  baseHeight: number,
  request: VideoExportRequest,
): Promise<VideoExportResult> {
  const mimeType = pickRecorderMimeType();
  if (!mimeType) {
    throw new Error('No supported video MIME type found for MediaRecorder.');
  }

  const dims = computeExportDimensions(state, baseWidth, baseHeight, request);

  const exportCanvas = document.createElement('canvas');
  exportCanvas.width = dims.width;
  exportCanvas.height = dims.height;
  const exportCtx = exportCanvas.getContext('2d', { willReadFrequently: true });
  if (!exportCtx) {
    throw new Error('Could not create 2D context for video export.');
  }

  const stream = exportCanvas.captureStream(0);
  const videoTrack = stream.getVideoTracks()[0];
  const recorder = new MediaRecorder(stream, {
    mimeType,
    videoBitsPerSecond: Math.max(4_000_000, dims.width * dims.height * dims.fps * 0.12),
  });

  const stopPromise = waitForRecorderStop(recorder);
  stopPromise.catch(() => {});
  recorder.start();

  renderer.clearPersistence();

  try {
    for await (const { frameResult } of exportVideoFrameLoop(
      renderer,
      state,
      liveAngles,
      request,
      dims,
    )) {
      exportCtx.putImageData(
        new ImageData(frameResult.data, frameResult.width, frameResult.height),
        0,
        0,
      );

      if ('requestFrame' in videoTrack && typeof videoTrack.requestFrame === 'function') {
        videoTrack.requestFrame();
      }
    }
  } finally {
    recorder.stop();
    videoTrack.stop();
    stream.getTracks().forEach((track) => track.stop());
    renderer.restoreRenderSize(dims.canvasWidth, dims.canvasHeight);
  }

  const blob = await stopPromise;
  const filename = buildExportFilename(request.filename, mimeType, extensionForMimeType);

  return {
    blob,
    mimeType,
    filename,
    frameCount: dims.totalFrames,
    width: dims.width,
    height: dims.height,
  };
}
