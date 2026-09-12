import { CANONICAL_LAYER_SPECS } from '../../graph/layerSpecs';
import { emitBandLayerGlsl } from '../../graph/templates/glsl';

/**
 * WebGL band-layer fragment shader, emitted from the `band-layer` GLSL
 * template. One shader serves every layer — `u_layerIndex` selects the band
 * ramp — so the layer count lives in the spec table, not here.
 */
export const LAYER_FRAGMENT_SOURCE = emitBandLayerGlsl(CANONICAL_LAYER_SPECS);
