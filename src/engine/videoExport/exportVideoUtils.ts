import type { ExportPassMode } from '../types/RendererContracts';
import type { ChromashiftState } from '../../state/types';
import { evenDimension } from './videoCodecs';
import type { VideoExportRequest } from './VideoExporter';

export function yieldToMain(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

function resolvePassMode(includeTracers: boolean, passMode: ExportPassMode): ExportPassMode {
  if (!includeTracers && passMode === 'composite') return 'layers';
  return passMode;
}

export function resolveStartAngles(
  state: ChromashiftState,
  liveAngles: number[],
  usePresetAngles: boolean,
): number[] {
  const start = usePresetAngles ? state.layers.angles : liveAngles;
  // `extensions` is the layer-count authority, as in `advanceAngles` — the live
  // clock may still be a frame behind a count change when an export starts.
  return state.layers.extensions.map((_, i) => start[i] ?? 0);
}

export interface ExportDimensions {
  fps: number;
  totalFrames: number;
  width: number;
  height: number;
  canvasWidth: number;
  canvasHeight: number;
  passMode: ExportPassMode;
}

export function computeExportDimensions(
  baseWidth: number,
  baseHeight: number,
  request: VideoExportRequest,
): ExportDimensions {
  const fps = Math.max(1, Math.min(60, Math.round(request.fps)));
  const durationSec = Math.max(0.5, request.durationSec);
  const totalFrames = Math.max(1, Math.round(durationSec * fps));
  const scale = Math.max(0.25, Math.min(2, request.resolutionScale));
  const width = evenDimension(baseWidth * scale);
  const height = evenDimension(baseHeight * scale);
  const passMode = resolvePassMode(request.includeTracers, request.passMode);
  const canvasWidth = Math.max(1, Math.round(baseWidth));
  const canvasHeight = Math.max(1, Math.round(baseHeight));

  return {
    fps,
    totalFrames,
    width,
    height,
    canvasWidth,
    canvasHeight,
    passMode,
  };
}

export function buildExportFilename(
  filename: string,
  mimeType: string,
  extensionForMime: (mime: string | null) => string,
): string {
  const ext = extensionForMime(mimeType);
  const baseName = filename.trim() || 'chromashift-export';
  return baseName.includes('.') ? baseName : `${baseName}.${ext}`;
}
