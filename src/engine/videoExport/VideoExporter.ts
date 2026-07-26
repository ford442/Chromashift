import type { ChromashiftRenderer, ExportPassMode } from '../types/RendererContracts';
import type { ChromashiftState, LayerTriple } from '../../state/types';
import { exportVideoMediaRecorder } from './exportVideoMediaRecorder';
import { probeVideoExportCapabilities, type VideoExportContainer, type VideoExportQuality } from './videoCodecs';

export interface VideoExportRequest {
  durationSec: number;
  fps: number;
  resolutionScale: number;
  includeTracers: boolean;
  passMode: ExportPassMode;
  filename: string;
  /** When true, frame 0 uses `layers.angles` from state instead of live animation angles. */
  usePresetAngles: boolean;
  container: VideoExportContainer;
  quality: VideoExportQuality;
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

/**
 * Offline frame-by-frame export. Prefers WebCodecs + mediabunny when available,
 * otherwise falls back to MediaRecorder + manual `requestFrame()`.
 */
export async function exportVideo(
  renderer: ChromashiftRenderer,
  state: ChromashiftState,
  liveAngles: LayerTriple<number>,
  baseWidth: number,
  baseHeight: number,
  request: VideoExportRequest,
): Promise<VideoExportResult> {
  const scale = Math.max(0.25, Math.min(2, request.resolutionScale));
  const probeWidth = Math.max(2, Math.round(baseWidth * scale));
  const probeHeight = Math.max(2, Math.round(baseHeight * scale));
  const caps = await probeVideoExportCapabilities(probeWidth, probeHeight);

  if (caps.preferredPath === 'webcodecs') {
    const { exportVideoWebCodecs } = await import('./exportVideoWebCodecs');
    return exportVideoWebCodecs(renderer, state, liveAngles, baseWidth, baseHeight, request, caps);
  }

  if (caps.mediaRecorder) {
    return exportVideoMediaRecorder(renderer, state, liveAngles, baseWidth, baseHeight, request);
  }

  throw new Error('This browser does not support video export (WebCodecs or MediaRecorder).');
}

export function downloadVideoExport(result: VideoExportResult): void {
  const href = URL.createObjectURL(result.blob);
  const link = document.createElement('a');
  link.href = href;
  link.download = result.filename;
  link.click();
  URL.revokeObjectURL(href);
}
