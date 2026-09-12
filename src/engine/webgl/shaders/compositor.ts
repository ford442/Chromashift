import { CANONICAL_LAYER_COUNT } from '../../graph/layerSpecs';
import { emitCompositorGlsl } from '../../graph/templates/glsl';

/**
 * WebGL compositor pass, emitted from the `blend` template so it tracks the
 * layer count the WGSL compositor uses.
 */
export const COMPOSITOR_FRAGMENT_SOURCE = emitCompositorGlsl(CANONICAL_LAYER_COUNT);
