import { WGSL_BLEND_HELPERS } from './common';
import { CANONICAL_LAYER_COUNT } from '../graph/layerSpecs';
import { emitCompositorWgsl } from '../graph/templates/wgsl';

// ─── Compositor fragment shader ─────────────────────────────────────────────────────────────────────
//
// Blends the "Below" persistence texture, then the 3 live layers,
// then the "Above" persistence texture on top.
//
export const compositorFragmentSource = emitCompositorWgsl(
  CANONICAL_LAYER_COUNT,
  WGSL_BLEND_HELPERS,
);
