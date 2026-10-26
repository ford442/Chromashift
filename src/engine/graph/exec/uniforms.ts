import { DEFAULT_PER_LAYER_OPACITY, RENDERER_STATE_DEFAULTS } from '../../../state/defaults';
import { durationToDecay } from '../../math/decay';
import { MAIN_VIEW_MODES } from '../../viewModes';
import type { RendererState } from '../../types/RendererState';
import type { UniformValues } from '../templates/uniformLayout';
import type {
  BandLayerUniformName,
  CompositorUniformName,
  PersistUniformName,
} from '../templates/wgsl';

/**
 * `RendererState` → uniform values, once, for every encode path.
 *
 * The hand encoders (since deleted), the graph executors, the stationary
 * previews and the WebGL passes each used to translate state into uniforms
 * themselves, with their own copy of every default. Every encode path now
 * calls the functions below and pack the
 * result with the layout the shader's emitter declares (`packUniforms`), so a
 * renderer can neither pick a different fallback nor put a field in the wrong
 * slot.
 *
 * Every function returns plain numbers keyed by field name; a `u32` flag is
 * already 0 / 1.
 */

type DefaultedField = keyof typeof RENDERER_STATE_DEFAULTS;

/**
 * `state[key]`, or what its absence means (`RENDERER_STATE_DEFAULTS`). The only
 * place a renderer reads an optional `RendererState` field with a fallback.
 */
export function rendererStateValue<K extends DefaultedField>(
  state: RendererState,
  key: K,
): NonNullable<RendererState[K]> {
  return (state[key] ?? RENDERER_STATE_DEFAULTS[key]) as NonNullable<RendererState[K]>;
}

const flag = (value: boolean): number => (value ? 1 : 0);

/** One layer's opacity: the global multiplier times its own. */
export function frameLayerOpacity(state: RendererState, index: number): number {
  const perLayer = state.layerOpacities?.[index] ?? DEFAULT_PER_LAYER_OPACITY;
  return rendererStateValue(state, 'layerOpacity') * perLayer;
}

/** {@link frameLayerOpacity} for `count` layers — the state's own count by default. */
export function frameLayerOpacities(state: RendererState, count = state.layers.length): number[] {
  return Array.from({ length: count }, (_, i) => frameLayerOpacity(state, i));
}

export interface BandLayerUniformContext {
  layerIndex: number;
  /**
   * False when the bound classification mask is the 1×1 fallback. `useMask`
   * must not claim a mask that does not exist.
   */
  hasClassificationMask: boolean;
}

/** `FragUniforms` of one `band-layer` pass. */
export function bandLayerUniforms(
  state: RendererState,
  context: BandLayerUniformContext,
): UniformValues<BandLayerUniformName> {
  const colorMode = rendererStateValue(state, 'colorMode');
  return {
    avgLuminance: state.avgLuminance,
    layerOpacity: frameLayerOpacity(state, context.layerIndex),
    colorMode,
    useMask: flag(context.hasClassificationMask && colorMode === 0),
    sobelEnabled: flag(rendererStateValue(state, 'sobelEnabled')),
    softCropEnabled: flag(rendererStateValue(state, 'softCropEnabled')),
    // Non-classic colour profiles render from the baked LUT (docs/COLOR_PROFILES.md).
    profileMode: flag(Boolean(state.colorProfileLut) && rendererStateValue(state, 'colorProfileMode') !== 0),
    profileLightDark: rendererStateValue(state, 'colorProfileLightDark'),
  };
}

/** The two tracer timescales the shipped pipeline accumulates. */
export type TracerRole = 'below' | 'above';

/** Configured lifetime of one tracer timescale, in milliseconds. */
export function tracerDurationMs(state: RendererState, role: TracerRole): number {
  return role === 'below'
    ? rendererStateValue(state, 'tracerBelowDuration')
    : rendererStateValue(state, 'tracerAboveDuration');
}

export interface PersistUniformContext {
  role: TracerRole;
  fps: number;
  /**
   * The accumulator's duration in renderer units, when it is not one of the
   * session's two (an extra timescale reads its node's `durationMs` through
   * {@link graphTracerDuration}). Overrides `role` for the decay factor.
   */
  durationMs?: number;
}

/**
 * A tracer duration authored on a graph node, in the renderer's units.
 *
 * `buildRendererState` hands the renderers the panel's tracer durations scaled
 * by `60 / fps`, so a duration written on a node in the panel's milliseconds
 * gets the same scaling: `durationMs: 2000` on a third tracer lasts exactly as
 * long as a 2000 ms panel setting would.
 */
export function graphTracerDuration(durationMs: number, fps: number): number {
  return durationMs * (60 / fps);
}

/**
 * `PersistUniforms` of one accumulator pass, motion fields included. The
 * non-motion layout has padding where the motion fields go, so packing these
 * into it writes the five fields that shipped and nothing else; the compute-fed
 * composite pass (`PERSIST_COMPOSITE_UNIFORMS`) takes the same values.
 */
export function persistUniforms(
  state: RendererState,
  context: PersistUniformContext,
): UniformValues<PersistUniformName> {
  return {
    decayFactor: durationToDecay(
      context.durationMs ?? tracerDurationMs(state, context.role),
      context.fps,
    ),
    colorThresh: rendererStateValue(state, 'tracerThreshold'),
    stampBoost: rendererStateValue(state, 'stampBoost'),
    tracerMode: rendererStateValue(state, 'tracerMode'),
    peakMode: flag(rendererStateValue(state, 'peakCollisionsOnly')),
    motionMode: rendererStateValue(state, 'motionMode'),
    motionGain: rendererStateValue(state, 'motionGain'),
    motionDecayBias: rendererStateValue(state, 'motionDecayBias'),
  };
}

/**
 * What an extra tracer timescale (a third accumulator and on) is drawn with
 * when its node does not say: a slow, faint echo under the shipped pair. Read
 * by both executors, so a graph's echo looks the same on either backend.
 */
export const EXTRA_TRACER_DURATION_MS = 4000;
export const EXTRA_TRACER_INTENSITY = 0.4;

export interface CompositorUniformOptions {
  /**
   * Opacities of the tracer timescales past the shipped two, in input order —
   * a graph's own, from each extra accumulator's `intensity`.
   */
  extraTracerOpacities?: readonly number[];
}

/** `CompositorUniforms` for a `layerCount`-layer compositor. */
export function compositorUniforms(
  state: RendererState,
  layerCount: number,
  options: CompositorUniformOptions = {},
): UniformValues<CompositorUniformName> {
  // The quarter-zoom / half-overlay transforms apply to the processed
  // composite only, never over an alternate main view. Exports, previews and
  // the quad cells switch them off in the state they render.
  const transforms = rendererStateValue(state, 'mainViewMode') === MAIN_VIEW_MODES.PROCESSED_COMPOSITE;
  const values: Record<string, number> = {
    tracerAboveOpacity: rendererStateValue(state, 'tracerAboveIntensity'),
    tracerBelowOpacity: rendererStateValue(state, 'tracerBelowIntensity'),
    layerBlendMode: rendererStateValue(state, 'layerBlendMode'),
    tracerBlendMode: rendererStateValue(state, 'tracerBlendMode'),
    diagnosticsOpacity: rendererStateValue(state, 'diagnosticsOpacity'),
    stampBoost: rendererStateValue(state, 'stampBoost'),
    outputMode: rendererStateValue(state, 'outputMode'),
    tracerMode: rendererStateValue(state, 'tracerMode'),
    diagnosticsMode: flag(rendererStateValue(state, 'diagnosticsMode')),
    viewportQuarterZoom: flag(transforms && rendererStateValue(state, 'viewportQuarterZoom')),
    halfOverlayAlpha: rendererStateValue(state, 'halfOverlayAlpha'),
    viewportHalfOverlay: flag(transforms && rendererStateValue(state, 'viewportHalfOverlay')),
  };
  for (let i = 0; i < layerCount; i += 1) values[`layerOpacity${i}`] = frameLayerOpacity(state, i);
  options.extraTracerOpacities?.forEach((opacity, k) => { values[`tracerOpacity${k + 2}`] = opacity; });
  return values as UniformValues<CompositorUniformName>;
}

/**
 * The tracer-inspect view's settings, as `TracerInspectPass.encodeTracerView`
 * takes them. Not a uniform block of its own — the pass packs these with the
 * canvas geometry it alone knows — but read from state here so the inspect
 * view's defaults are the same ones as everything else's.
 */
export function tracerInspectSettings(state: RendererState) {
  return {
    tracerAboveOpacity: rendererStateValue(state, 'tracerAboveIntensity'),
    tracerBelowOpacity: rendererStateValue(state, 'tracerBelowIntensity'),
    tracerBlendMode: rendererStateValue(state, 'tracerBlendMode'),
    layerBlendMode: rendererStateValue(state, 'layerBlendMode'),
    layerOpacities: frameLayerOpacities(state),
    inspectZoom: rendererStateValue(state, 'tracerInspectZoom'),
    inspectPanX: rendererStateValue(state, 'tracerInspectPanX'),
    inspectPanY: rendererStateValue(state, 'tracerInspectPanY'),
    showHeatmap: rendererStateValue(state, 'tracerInspectHeatmap'),
    exposure: rendererStateValue(state, 'tracerInspectExposure'),
    applyTonemap: rendererStateValue(state, 'tracerInspectTonemap'),
    showLayers: rendererStateValue(state, 'tracerInspectShowLayers'),
  };
}
