import { MAIN_VIEW_MODES } from './viewModes';
import { motionModeIndex } from './motionModes';
import { getColorProfileLut, isClassicProfile } from './color/colorProfile';
import { resolveColorProfile } from './color/colorProfileLibrary';
import type { ChromashiftState } from '../state/types';
import type { LayerState, RendererState } from './types/RendererState';

function createLayerState(): LayerState {
  return { angleDeg: 0, flipX: false, flipY: false };
}

/** Blank {@link RendererState} with an empty `layers` array, ready to be mutated in place. */
function createRendererState(): RendererState {
  return { layers: [], avgLuminance: 0 };
}

/**
 * Grow or shrink `layers` to `count` entries, reusing the `LayerState` objects
 * that are already there.
 *
 * The per-frame path mutates one `RendererState` in place (see below), so a
 * layer-count change must resize the array without replacing the entries a
 * renderer may still be holding by identity.
 */
function resizeLayers(target: RendererState, count: number): void {
  while (target.layers.length < count) target.layers.push(createLayerState());
  if (target.layers.length > count) target.layers.length = count;
}

/**
 * Layer 1 renders mirrored vertically — the one piece of per-layer geometry the
 * shipped three-band look carries that is not in the band table. Generalised as
 * "every odd layer flips", which reproduces the 3-layer default exactly.
 */
function flipYForLayer(index: number): boolean {
  return index % 2 === 1;
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
 * the same `RendererState` object (and its `layers` array) across calls instead
 * of allocating a fresh object graph every frame: the renderer consumes the
 * state synchronously inside `render()` and never retains it, so mutating it in
 * place is safe. Omit `slot` for one-off callers (tests, WebXR, offline video
 * export) that don't run on the per-frame hot path and don't need reuse.
 */
export function buildRendererState(
  state: ChromashiftState,
  angles: number[],
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

  // The angle array is the authority on how many layers this frame has: it is
  // produced from `layers.angles`, which the reducer keeps at `layers.count`.
  resizeLayers(target, angles.length);
  for (let i = 0; i < angles.length; i += 1) {
    const layer = target.layers[i];
    layer.angleDeg = angles[i];
    layer.flipX = false;
    layer.flipY = flipYForLayer(i);
  }

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
  target.motionMode = motionModeIndex(tracers.motionMode);
  target.motionGain = tracers.motionGain;
  target.motionDecayBias = tracers.motionDecayBias;
  target.motionThreshold = tracers.motionThreshold;
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
