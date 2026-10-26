import { WGSL_BLEND_HELPERS, WGSL_COLOR_HELPERS } from '../../shaders/common';
import { CANONICAL_LAYER_COUNT, CANONICAL_LAYER_SPECS } from '../layerSpecs';
import { emitBandLayerWgsl, emitCoincidenceDecayWgsl, emitCompositorWgsl } from './wgsl';

/**
 * The default graph's WGSL at the canonical three layers, by the names the
 * hand-written shader modules exported.
 *
 * Nothing in the renderer binds these — it draws whatever `compileGraph`
 * emits, at any layer count. They exist so the goldens in `__golden__/` and
 * the shader tests can name a pass, and `shaders/{layers,persistence,
 * compositor}.ts` re-export them under their old paths.
 */
/** Every default-graph layer shader, in layer order. */
const layerFragmentSources: readonly string[] = CANONICAL_LAYER_SPECS.map((spec) =>
  emitBandLayerWgsl(spec, WGSL_COLOR_HELPERS),
);

// The canonical table is the three layers named below.
/** Layer 0 — high luminance → red / orange. */
export const fragmentShaderRedOrange = layerFragmentSources[0]!;
/** Layer 1 — mid-high luminance → violet / blue. */
export const fragmentShaderVioletBlue = layerFragmentSources[1]!;
/** Layer 2 — mid luminance → green / yellow. */
export const fragmentShaderGreenYellow = layerFragmentSources[2]!;

/** The fused coincidence + decay accumulator pass. */
export const persistenceFragmentSource = emitCoincidenceDecayWgsl(CANONICAL_LAYER_COUNT);

/**
 * The same pass with the temporal term — a separate module, not a branch, so
 * that `motionMode: 'off'` binds byte-for-byte the shader that shipped before
 * the term existed. See `docs/LIVE_SOURCE.md`.
 */
export const persistenceMotionFragmentSource = emitCoincidenceDecayWgsl(
  CANONICAL_LAYER_COUNT,
  { motion: true },
);

/** The compositor: below tracer, the live layers, above tracer. */
export const compositorFragmentSource = emitCompositorWgsl(CANONICAL_LAYER_COUNT, WGSL_BLEND_HELPERS);
