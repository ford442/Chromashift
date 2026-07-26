import type { ChromashiftRenderer } from '../types/RendererContracts';
import type { ChromashiftState, LayerTriple } from '../../state/types';
import { exportVideoFrameLoop } from './exportVideoFrameLoop';
import {
  buildExportFilename,
  computeExportDimensions,
} from './exportVideoUtils';
import {
  extensionForMimeType,
  resolveWebCodecsContainer,
  type VideoExportCapabilities,
} from './videoCodecs';
import type { VideoExportRequest, VideoExportResult } from './VideoExporter';

type MediabunnyModule = typeof import('mediabunny');

function qualityBitrate(quality: VideoExportRequest['quality'], mediabunny: MediabunnyModule) {
  switch (quality) {
    case 'low':
      return mediabunny.QUALITY_LOW;
    case 'medium':
      return mediabunny.QUALITY_MEDIUM;
  }
  return mediabunny.QUALITY_HIGH;
}

/**
 * Offline frame-by-frame export via WebCodecs VideoEncoder + mediabunny muxer.
 * mediabunny is lazy-loaded so it stays out of the initial bundle.
 */
export async function exportVideoWebCodecs(
  renderer: ChromashiftRenderer,
  state: ChromashiftState,
  liveAngles: LayerTriple<number>,
  baseWidth: number,
  baseHeight: number,
  request: VideoExportRequest,
  caps: VideoExportCapabilities,
): Promise<VideoExportResult> {
  const mediabunny = await import('mediabunny');
  const dims = computeExportDimensions(state, baseWidth, baseHeight, request);
  const container = resolveWebCodecsContainer(request.container, caps);

  const format = container === 'mp4'
    ? new mediabunny.Mp4OutputFormat()
    : new mediabunny.WebMOutputFormat();

  const codec = await mediabunny.getFirstEncodableVideoCodec(
    format.getSupportedVideoCodecs(),
    { width: dims.width, height: dims.height },
  );
  if (!codec) {
    throw new Error(`No encodable video codec found for ${container.toUpperCase()} at ${dims.width}x${dims.height}.`);
  }

  const exportCanvas = document.createElement('canvas');
  exportCanvas.width = dims.width;
  exportCanvas.height = dims.height;
  const exportCtx = exportCanvas.getContext('2d', { willReadFrequently: true });
  if (!exportCtx) {
    throw new Error('Could not create 2D context for video export.');
  }

  const target = new mediabunny.BufferTarget();
  const output = new mediabunny.Output({ format, target });
  const source = new mediabunny.CanvasSource(exportCanvas, {
    codec,
    bitrate: qualityBitrate(request.quality, mediabunny),
  });
  output.addVideoTrack(source);

  await output.start();
  renderer.clearPersistence();

  try {
    for await (const { frameResult, frameIndex } of exportVideoFrameLoop(
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
      await source.add(frameIndex / dims.fps, 1 / dims.fps);
    }

    await output.finalize();
  } catch (error) {
    await output.cancel();
    throw error;
  } finally {
    renderer.restoreRenderSize(dims.canvasWidth, dims.canvasHeight);
  }

  const buffer = target.buffer;
  if (!buffer) {
    throw new Error('WebCodecs export produced no output buffer.');
  }

  const mimeType = await output.getMimeType();
  const blob = new Blob([buffer], { type: mimeType });
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
