import { MAIN_VIEW_MODES } from './viewModes';
import { getColorProfileLut, isClassicProfile } from './color/colorProfile';
import { resolveColorProfile } from './color/colorProfileLibrary';
import type { ChromashiftState } from '../state/types';
import type { LayerState, RendererState } from './types/RendererState';

function createLayerState(): LayerState {
  return { angleDeg: 0, flipX: false, flipY: false };
}

/** Blank {@link RendererState} with a stable `layers` tuple, ready to be mutated in place. */
function createRendererState(): RendererState {
  return {
    layers: [createLayerState(), createLayerState(), createLayerState()],
    avgLuminance: 0,
  };
}

/** One reused `RendererState` per renderer slot (main viewport, compare slot B, ...). */
const rendererStateSlots = new Map<string, RendererState>();

function rendererStateForSlot(slot: string): RendererState {
  let target = rendererStateSlots.get(slot);
  if (!target) {
    target = createRendererState();
    rendererStateSlots.set(slot, target);
  }
  return target;
}

/**
 * Build a {@link RendererState} snapshot from app state and live animation angles.
 *
 * `useAnimationLoop` calls this every frame, once per active renderer slot (main
 * viewport, compare slot B). Pass a stable `slot` id to write into — and reuse —
 * the same `RendererState` object (and its `layers` tuple) across calls instead
 * of allocating a fresh object graph every frame: the renderer consumes the
 * state synchronously inside `render()` and never retains it, so mutating it in
 * place is safe. Omit `slot` for one-off callers (tests, WebXR, offline video
 * export) that don't run on the per-frame hot path and don't need reuse.
 */
export function buildRendererState(
  state: ChromashiftState,
  angles: [number, number, number],
  overrides: Partial<RendererState> = {},
  slot?: string,
): RendererState {
  const target = slot === undefined ? createRendererState() : rendererStateForSlot(slot);
  const { layers, tracers, output, engine } = state;
  const isViewingTracer = output.mainViewMode === MAIN_VIEW_MODES.FULL_RES_TRACER;
  const inspect = output.tracerInspect;

  // Hybrid profile strategy: Classic keeps the branchy shaders (zero risk to the
  // default look); every other profile is baked into a LUT the shaders sample.
  const { profile } = resolveColorProfile(layers.colorProfileId, layers.colorProfile);
  const useProfileLut = !isClassicProfile(profile);

  const [layer0, layer1, layer2] = target.layers;
  layer0.angleDeg = angles[0];
  layer0.flipX = false;
  layer0.flipY = false;
  layer1.angleDeg = angles[1];
  layer1.flipX = false;
  layer1.flipY = true;
  layer2.angleDeg = angles[2];
  layer2.flipX = false;
  layer2.flipY = false;

  target.avgLuminance = engine.avgLuminance;
  target.layerOpacity = layers.opacity;
  target.layerOpacities = layers.opacities;
  target.layerScale = layers.scale;
  target.tracerScale = tracers.scale;
  target.tracerAboveIntensity = tracers.aboveIntensity;
  target.tracerBelowIntensity = tracers.belowIntensity;
  target.tracerAboveDuration = tracers.aboveDuration * (60 / engine.fps);
  target.tracerBelowDuration = tracers.belowDuration * (60 / engine.fps);
  target.tracerMode = tracers.mode;
  target.colorMode = layers.colorMode;
  target.colorProfileLut = useProfileLut ? getColorProfileLut(profile, engine.avgLuminance) : null;
  target.colorProfileMode = useProfileLut ? 1 : 0;
  target.colorProfileLightDark = profile.preprocess.lightDarkMode === 'classic' ? 1 : 0;
  target.sobelEnabled = layers.sobelEnabled;
  target.softCropEnabled = layers.softCropEnabled;
  target.layerBlendMode = tracers.layerBlendMode;
  target.tracerBlendMode = tracers.tracerBlendMode;
  target.outputMode = output.outputMode;
  target.paused = engine.paused;
  target.mainViewMode = output.mainViewMode;
  target.showTracerView = isViewingTracer;
  target.tracerInspectZoom = inspect.zoom;
  target.tracerInspectPanX = inspect.pan.x;
  target.tracerInspectPanY = inspect.pan.y;
  target.tracerInspectHeatmap = inspect.heatmap;
  target.tracerInspectExposure = inspect.exposure;
  target.tracerInspectTonemap = inspect.tonemap;
  target.tracerInspectShowLayers = inspect.showLayers;
  target.diagnosticsMode = output.diagnosticsMode;
  target.diagnosticsOpacity = output.diagnosticsOpacity;
  target.stampBoost = output.stampBoost;
  target.peakCollisionsOnly = output.peakCollisionsOnly;
  target.webglDebugMode = output.webglDebugMode;
  target.viewportQuarterZoom = output.viewportQuarterZoom;
  target.viewportHalfOverlay = output.viewportHalfOverlay;
  target.halfOverlayAlpha = 0.5;
  target.livePreviewEnabled = output.livePreviewEnabled;
  target.profilePerformance = output.performanceHudEnabled;

  Object.assign(target, overrides);

  return target;
}
