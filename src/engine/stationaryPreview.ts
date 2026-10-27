import type { ChromashiftState } from '../state/types';
import { buildRendererState } from './buildRendererState';
import { MAX_LAYER_COUNT } from './graph/layerSpecs';
import type { ChromashiftRenderer } from './types/RendererContracts';
import type { RendererState } from './types/RendererState';
import { MAIN_VIEW_MODES } from './viewModes';

/** Thumbnail edge length for side previews. */
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

/**
 * What one `renderStationaryPreviews` call draws, resolved from its options —
 * the backend-agnostic half of both stationary preview renderers.
 */
export interface StationaryPreviewPlan {
  size: number;
  fps: number;
  warmupFrames: number;
  separated: boolean;
  tracer: boolean;
  /** The session's layer count, clamped to what the default graph builds. */
  layerCount: number;
  /**
   * The thumbnail's own state: its own size at every scale — the session's
   * layer and tracer scales are for the main canvas.
   */
  state: RendererState;
}

export function planStationaryPreview(
  state: RendererState,
  options: StationaryPreviewOptions = {},
): StationaryPreviewPlan {
  return {
    size: STATIONARY_PREVIEW_SIZE,
    fps: options.fps ?? 30,
    warmupFrames: options.tracerWarmupFrames ?? STATIONARY_TRACER_WARMUP_FRAMES,
    separated: options.separated !== false,
    tracer: options.tracer !== false,
    layerCount: Math.max(1, Math.min(MAX_LAYER_COUNT, state.layers.length)),
    state: { ...state, layerScale: 1, tracerScale: 1 },
  };
}

/**
 * The *Separated* thumbnail: the bands alone — the processed composite with
 * no tracers and no diagnostics overlay, as a still (the accumulators neither
 * advance nor flip).
 */
export function separatedPreviewState(state: RendererState): RendererState {
  return {
    ...state,
    tracerAboveIntensity: 0,
    tracerBelowIntensity: 0,
    mainViewMode: MAIN_VIEW_MODES.PROCESSED_COMPOSITE,
    viewportQuarterZoom: false,
    viewportHalfOverlay: false,
    diagnosticsMode: false,
    diagnosticsOpacity: 0,
    paused: true,
  };
}

/**
 * The *Tracer* thumbnail's warmup frames. The preview state is a paused one
 * (it is a still), but the warmup has to accumulate.
 */
export function tracerWarmupState(state: RendererState): RendererState {
  return { ...state, paused: false };
}

/** Build renderer state at panel preset angles (not live animation angles). */
export function buildStationaryRendererState(
  state: ChromashiftState,
  overrides: Partial<RendererState> = {},
): RendererState {
  const presetAngles = state.layers.angles as number[];
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

/** Fingerprint for quad stationary cells (includes layer cycle index). */
export function quadStationaryFingerprint(state: ChromashiftState): string {
  return `${stationaryPreviewFingerprint(state)}|quadLayer:${state.ui.compareView.quadLayerIndex}`;
}

/**
 * Warm up tracer persistence at preset angles before displaying a stationary tracer view.
 * Used by quad cell C and {@link StationaryPreviewRenderer}.
 */
export function warmupTracerPersistence(
  renderer: ChromashiftRenderer,
  warmupState: RendererState,
  fps: number,
  frames: number = STATIONARY_TRACER_WARMUP_FRAMES,
): void {
  renderer.clearPersistence();
  const compositeState: RendererState = {
    ...warmupState,
    mainViewMode: MAIN_VIEW_MODES.PROCESSED_COMPOSITE,
    showTracerView: false,
    paused: false,
  };
  for (let i = 0; i < frames; i += 1) {
    renderer.render(compositeState, fps);
  }
}
