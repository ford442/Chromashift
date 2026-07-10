import { MAIN_VIEW_MODES } from './viewModes';
import type { ChromashiftState } from '../state/types';
import type { RendererState } from './types/RendererState';

/** Build a {@link RendererState} snapshot from app state and live animation angles. */
export function buildRendererState(
  state: ChromashiftState,
  angles: [number, number, number],
  overrides: Partial<RendererState> = {},
): RendererState {
  const { layers, tracers, output, engine } = state;
  const isViewingTracer = output.mainViewMode === MAIN_VIEW_MODES.FULL_RES_TRACER;
  const inspect = output.tracerInspect;

  return {
    layers: [
      { angleDeg: angles[0], flipX: false, flipY: false },
      { angleDeg: angles[1], flipX: false, flipY: true },
      { angleDeg: angles[2], flipX: false, flipY: false },
    ],
    avgLuminance: engine.avgLuminance,
    layerOpacity: layers.opacity,
    layerOpacities: layers.opacities,
    layerScale: layers.scale,
    tracerScale: tracers.scale,
    tracerAboveIntensity: tracers.aboveIntensity,
    tracerBelowIntensity: tracers.belowIntensity,
    tracerAboveDuration: tracers.aboveDuration * (60 / engine.fps),
    tracerBelowDuration: tracers.belowDuration * (60 / engine.fps),
    tracerMode: tracers.mode,
    colorMode: layers.colorMode,
    sobelEnabled: layers.sobelEnabled,
    softCropEnabled: layers.softCropEnabled,
    layerBlendMode: tracers.layerBlendMode,
    tracerBlendMode: tracers.tracerBlendMode,
    outputMode: output.outputMode,
    paused: engine.paused,
    mainViewMode: output.mainViewMode,
    showTracerView: isViewingTracer,
    tracerInspectZoom: inspect.zoom,
    tracerInspectPanX: inspect.pan.x,
    tracerInspectPanY: inspect.pan.y,
    tracerInspectHeatmap: inspect.heatmap,
    tracerInspectExposure: inspect.exposure,
    tracerInspectTonemap: inspect.tonemap,
    tracerInspectShowLayers: inspect.showLayers,
    diagnosticsMode: output.diagnosticsMode,
    diagnosticsOpacity: output.diagnosticsOpacity,
    stampBoost: output.stampBoost,
    peakCollisionsOnly: output.peakCollisionsOnly,
    webglDebugMode: output.webglDebugMode,
    viewportQuarterZoom: output.viewportQuarterZoom,
    viewportHalfOverlay: output.viewportHalfOverlay,
    halfOverlayAlpha: 0.5,
    ...overrides,
  };
}
