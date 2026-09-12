import { WGSL_COLOR_HELPERS } from './common';
import { CANONICAL_LAYER_SPECS } from '../graph/layerSpecs';
import { emitBandLayerWgsl } from '../graph/templates/wgsl';

/**
 * Layer fragment shaders, emitted from the `band-layer` template.
 *
 * There used to be three hand-written shaders here; there is now one template
 * and a band table (see graph/layerSpecs.ts), so the layer count is data rather
 * than a literal. The named exports below are the three layers the default
 * graph ships — `compileGraph` emits the same sources for any other count.
 */
const [redOrange, violetBlue, greenYellow] = CANONICAL_LAYER_SPECS.map((spec) =>
  emitBandLayerWgsl(spec, WGSL_COLOR_HELPERS),
);

/** Layer 0 — high luminance → red / orange. */
export const fragmentShaderRedOrange = redOrange;
/** Layer 1 — mid-high luminance → violet / blue. */
export const fragmentShaderVioletBlue = violetBlue;
/** Layer 2 — mid luminance → green / yellow. */
export const fragmentShaderGreenYellow = greenYellow;

/** Every default-graph layer shader, in layer order. */
export const layerFragmentSources: readonly string[] = [redOrange, violetBlue, greenYellow];
