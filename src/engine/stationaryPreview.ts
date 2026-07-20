import type { ChromashiftState } from '../state/types';
import type { LayerTriple } from '../state/types';
import { buildRendererState } from './buildRendererState';
import type { RendererState } from './types/RendererState';

/** Thumbnail edge length for side previews (matches GpuReadback.PREVIEW_SIZE). */
export const STATIONARY_PREVIEW_SIZE = 128;

/** Persistence frames at preset angles before capturing the tracer thumbnail. */
export const STATIONARY_TRACER_WARMUP_FRAMES = 24;

export interface StationaryPreviewResult {
  separated: Uint8ClampedArray<ArrayBuffer> | null;
  tracer: Uint8ClampedArray<ArrayBuffer> | null;
}

export interface StationaryPreviewOptions {
  fps?: number;
  tracerWarmupFrames?: number;
  /** When false, skip the Separated (layers) thumbnail. Default true. */
  separated?: boolean;
  /** When false, skip the Tracer thumbnail. Default true. */
  tracer?: boolean;
}

/** Build renderer state at panel preset angles (not live animation angles). */
export function buildStationaryRendererState(
  state: ChromashiftState,
  overrides: Partial<RendererState> = {},
): RendererState {
  const presetAngles = state.layers.angles as LayerTriple<number>;
  return buildRendererState(state, presetAngles, {
    paused: true,
    mainViewMode: 0,
    viewportQuarterZoom: false,
    viewportHalfOverlay: false,
    diagnosticsMode: false,
    livePreviewEnabled: false,
    profilePerformance: false,
    ...overrides,
  });
}

/** Settings that should trigger a stationary preview refresh (not animation angles). */
export function stationaryPreviewFingerprint(state: ChromashiftState): string {
  const { media, layers, tracers, engine, output } = state;
  return JSON.stringify({
    imageIndex: media.currentIndex,
    avgLuminance: engine.avgLuminance,
    layers: {
      angles: layers.angles,
      colorMode: layers.colorMode,
      sobelEnabled: layers.sobelEnabled,
      softCropEnabled: layers.softCropEnabled,
      opacity: layers.opacity,
      opacities: layers.opacities,
      scale: layers.scale,
    },
    tracers: {
      mode: tracers.mode,
      aboveIntensity: tracers.aboveIntensity,
      belowIntensity: tracers.belowIntensity,
      aboveDuration: tracers.aboveDuration,
      belowDuration: tracers.belowDuration,
      scale: tracers.scale,
      layerBlendMode: tracers.layerBlendMode,
      tracerBlendMode: tracers.tracerBlendMode,
    },
    output: {
      outputMode: output.outputMode,
      stampBoost: output.stampBoost,
      peakCollisionsOnly: output.peakCollisionsOnly,
    },
  });
}
